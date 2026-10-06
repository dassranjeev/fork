import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Restaurant } from '../database/entities';
import { MenuEditStatus, UserType } from '../common/enums';
import { AuthUser } from '../common/auth.types';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeService } from '../realtime/realtime.module';
import { SettingsService } from '../settings/settings.service';

/**
 * Menu self-service is controlled by FORKSY staff, restaurant by restaurant.
 *  - ALLOWED      the restaurant may add / update / remove menu items, categories and modifiers
 *  - NOT_ALLOWED  read-only menu (it can still 86 / restock items, which is day-to-day operations)
 *  - REQUESTED    the restaurant asked for access; staff decide
 * New restaurants start NOT_ALLOWED. Restaurants that existed before this feature were grandfathered to ALLOWED once.
 */
@Injectable()
export class MenuAccessService implements OnModuleInit {
  private readonly logger = new Logger(MenuAccessService.name);

  constructor(
    @InjectRepository(Restaurant) private restaurants: Repository<Restaurant>,
    private settings: SettingsService,
    private audit: AuditService,
    private notifications: NotificationsService,
    private rt: RealtimeService,
  ) {}

  /** one-off, idempotent: restaurants that already existed keep the ability to edit their menu */
  async onModuleInit() {
    try {
      if (this.settings.get<boolean>('restaurants.menuAccessMigrated', false)) return;
      const r = await this.restaurants
        .createQueryBuilder()
        .update(Restaurant)
        .set({ menuEditStatus: MenuEditStatus.ALLOWED, menuEditDecidedAt: new Date(), menuEditDecisionNote: 'Existing restaurant: access granted when menu permissions were introduced' })
        .where('"menuEditStatus" = :s AND "menuEditDecidedAt" IS NULL', { s: MenuEditStatus.NOT_ALLOWED })
        .execute();
      await this.settings.set('restaurants.menuAccessMigrated', true);
      this.logger.log(`menu access: grandfathered ${r.affected ?? 0} existing restaurants`);
    } catch (e) {
      this.logger.warn(`menu access migration skipped: ${(e as Error).message}`);
    }
  }

  private async get(id: string) {
    const r = await this.restaurants.findOne({ where: { id } });
    if (!r) throw new NotFoundException('Restaurant not found');
    return r;
  }

  view(r: Restaurant) {
    return {
      status: r.menuEditStatus,
      canEdit: r.menuEditStatus === MenuEditStatus.ALLOWED,
      requestedAt: r.menuEditRequestedAt,
      requestNote: r.menuEditRequestNote,
      decidedAt: r.menuEditDecidedAt,
      decisionNote: r.menuEditDecisionNote,
    };
  }

  async access(restaurantId: string) {
    return this.view(await this.get(restaurantId));
  }

  /** Called before every add / update / remove on the menu. An admin viewing the portal as the owner sees exactly what the owner sees. */
  async assertCanEdit(restaurantId: string, user?: AuthUser | null) {
    if (user && user.type !== UserType.RESTAURANT) return; // staff routes never reach the portal menu; an impersonated owner session is restricted like the owner
    const row = await this.restaurants.findOne({ where: { id: restaurantId }, select: ['id', 'menuEditStatus'] });
    if (!row) throw new NotFoundException('Restaurant not found');
    if (row.menuEditStatus !== MenuEditStatus.ALLOWED) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'MENU_EDIT_NOT_ALLOWED',
        message: row.menuEditStatus === MenuEditStatus.REQUESTED ? 'Your request to edit the menu is waiting for FORKSY approval.' : 'Editing the menu is turned off for this restaurant. Request access from FORKSY and an administrator will review it.',
        status: row.menuEditStatus,
      });
    }
  }

  /** Restaurant owner / manager asks to be allowed to edit the menu. */
  async request(restaurantId: string, note: string | undefined, user: AuthUser) {
    const r = await this.get(restaurantId);
    if (r.menuEditStatus === MenuEditStatus.ALLOWED) throw new BadRequestException('Menu editing is already allowed for this restaurant');
    if (r.menuEditStatus === MenuEditStatus.REQUESTED) throw new ConflictException('A request is already waiting for approval');
    r.menuEditStatus = MenuEditStatus.REQUESTED;
    r.menuEditRequestedAt = new Date();
    r.menuEditRequestNote = note?.trim().slice(0, 500) || null;
    await this.restaurants.save(r);
    await this.audit.log({ actor: user, action: 'restaurant.menu_access_requested', entity: 'restaurant', entityId: r.id, after: { note: r.menuEditRequestNote } });
    await this.notifications.notifyOps('menu.access_requested', { name: r.name, note: r.menuEditRequestNote ?? '' }, { restaurantId: r.id }).catch(() => undefined);
    this.rt.emitToRestaurant(r.id, 'menu.access_changed', this.view(r));
    return this.view(r);
  }

  /** Staff allow or disallow menu editing, at any time, with or without a prior request. */
  async decide(restaurantId: string, allowed: boolean, note: string | undefined, actor: AuthUser, req?: any) {
    const r = await this.get(restaurantId);
    const before = this.view(r);
    r.menuEditStatus = allowed ? MenuEditStatus.ALLOWED : MenuEditStatus.NOT_ALLOWED;
    r.menuEditDecidedAt = new Date();
    r.menuEditDecidedById = actor.id;
    r.menuEditDecisionNote = note?.trim().slice(0, 500) || null;
    await this.restaurants.save(r);
    const after = this.view(r);
    if (req) await this.audit.logReq(req, allowed ? 'restaurant.menu_access_allowed' : 'restaurant.menu_access_disallowed', 'restaurant', r.id, before, after);
    else await this.audit.log({ actor, action: allowed ? 'restaurant.menu_access_allowed' : 'restaurant.menu_access_disallowed', entity: 'restaurant', entityId: r.id, before, after });
    await this.notifications.notifyRestaurant(r.id, 'menu.access_decided', { name: r.name, decision: allowed ? 'allowed' : 'turned off', note: r.menuEditDecisionNote ?? '' }).catch(() => undefined);
    this.rt.emitToRestaurant(r.id, 'menu.access_changed', after);
    return { id: r.id, name: r.name, ...after };
  }

  /** Staff queue: restaurants with their menu-access status (default: waiting requests first). */
  async list(status?: string) {
    const qb = this.restaurants
      .createQueryBuilder('r')
      .select(['r.id', 'r.name', 'r.city', 'r.status', 'r.menuEditStatus', 'r.menuEditRequestedAt', 'r.menuEditRequestNote', 'r.menuEditDecidedAt', 'r.menuEditDecisionNote']);
    if (status && (Object.values(MenuEditStatus) as string[]).includes(status)) qb.where('r.menuEditStatus = :s', { s: status });
    qb.orderBy('r.name', 'ASC').limit(500);
    const rows = (await qb.getMany()).sort((a, b) => Number(b.menuEditStatus === MenuEditStatus.REQUESTED) - Number(a.menuEditStatus === MenuEditStatus.REQUESTED));
    return { items: rows.map((r) => ({ id: r.id, name: r.name, city: r.city, restaurantStatus: r.status, ...this.view(r) })), pending: rows.filter((r) => r.menuEditStatus === MenuEditStatus.REQUESTED).length };
  }
}
