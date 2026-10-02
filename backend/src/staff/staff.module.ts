import {
  BadRequestException,
  Body,
  ConflictException,
  Delete,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  NotFoundException,
  OnModuleInit,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm';
import { randomBytes, randomInt } from 'crypto';
import * as bcrypt from 'bcryptjs';
import { Brackets, In, IsNull, Repository } from 'typeorm';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsEnum, IsNumber, IsObject, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { RefreshToken, Role, User } from '../database/entities';
import { AdminController, CurrentUser, Permission } from '../common/decorators';
import { AuthUser } from '../common/auth.types';
import { Action, Module as Mod, UserStatus, UserType } from '../common/enums';
import { ALL_MODULES, DEFAULT_ROLES } from '../common/default-roles';
import { PageQueryDto, paginateQb, like } from '../common/pagination';
import { AuditService } from '../audit/audit.service';
import { JwtStrategy } from '../auth/jwt.strategy';
import { NotificationsService } from '../notifications/notifications.service';

// ------------------------------------------------------------------ DTOs
class RoleDto {
  @IsString() @MaxLength(80) name: string;
  @IsOptional() @IsString() @MaxLength(300) description?: string;
  @IsObject() permissions: Record<string, string[]>;
  /** null = unlimited, only a Super Admin may set it */
  @IsOptional() @IsNumber({ allowNaN: false, allowInfinity: false }) @Min(0) @Max(100000) refundLimit?: number | null;
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsUUID('all', { each: true }) cityIds?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsUUID('all', { each: true }) zoneIds?: string[];
}

class UpdateRoleDto {
  @IsOptional() @IsString() @MaxLength(80) name?: string;
  @IsOptional() @IsString() @MaxLength(300) description?: string;
  @IsOptional() @IsObject() permissions?: Record<string, string[]>;
  @IsOptional() @IsNumber({ allowNaN: false, allowInfinity: false }) @Min(0) @Max(100000) refundLimit?: number | null;
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsUUID('all', { each: true }) cityIds?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsUUID('all', { each: true }) zoneIds?: string[];
}

class CloneRoleDto {
  @IsString() @MaxLength(80) name: string;
}

class CreateStaffDto {
  @IsEmail() @MaxLength(254) email: string;
  @IsString() @MaxLength(80) firstName: string;
  @IsString() @MaxLength(80) lastName: string;
  @IsOptional() @IsString() @MaxLength(30) phone?: string;
  /** Role id. Omit only when creating another SUPER_ADMIN. */
  @IsOptional() @IsUUID() roleId?: string;
  @IsOptional() @IsBoolean() superAdmin?: boolean;
  /** if not set a random temporary password is generated and returned once */
  @IsOptional() @IsString() @MinLength(10) @MaxLength(128) password?: string;
}

class UpdateStaffDto {
  @IsOptional() @IsString() @MaxLength(80) firstName?: string;
  @IsOptional() @IsString() @MaxLength(80) lastName?: string;
  @IsOptional() @IsString() @MaxLength(30) phone?: string;
  @IsOptional() @IsUUID() roleId?: string;
  @IsOptional() @IsEnum(UserStatus) status?: UserStatus;
}

class StaffQuery extends PageQueryDto {
  @IsOptional() @IsUUID() roleId?: string;
  @IsOptional() @IsEnum(UserStatus) status?: string;
}

// ------------------------------------------------------------------ service
@Injectable()
export class StaffService implements OnModuleInit {
  constructor(
    @InjectRepository(User) private users: Repository<User>,
    @InjectRepository(Role) private roles: Repository<Role>,
    @InjectRepository(RefreshToken) private tokens: Repository<RefreshToken>,
    private audit: AuditService,
    private strategy: JwtStrategy,
    private notifications: NotificationsService,
  ) {}

  /** Make sure the default staff roles exist (idempotent; never overwrites edited roles). */
  async onModuleInit() {
    const existing = new Set((await this.roles.find({ select: ['name'] })).map((r) => r.name));
    const missing = DEFAULT_ROLES.filter((r) => !existing.has(r.name));
    if (missing.length) await this.roles.insert(missing.map((r) => ({ ...r, isSystem: true })));
  }

  sanitizePermissions(p: Record<string, string[]>) {
    const valid = new Set<string>(ALL_MODULES);
    const actions = new Set<string>(Object.values(Action));
    const out: Record<string, string[]> = {};
    for (const [m, acts] of Object.entries(p ?? {})) {
      if (!valid.has(m)) throw new BadRequestException(`Unknown module: ${m}`);
      const list = [...new Set(acts)];
      for (const a of list) if (!actions.has(a)) throw new BadRequestException(`Unknown action: ${a}`);
      if (list.length) out[m] = list;
    }
    return out;
  }

  /** Names that must never be used for a custom role (several code paths historically compared role names). */
  private static RESERVED = /^\s*(super[\s_-]?admin|root|system|owner)\s*$/i;

  /**
   * Privilege ceiling: a staff member can never hand out (or edit/act on) more than they hold themselves.
   * SUPER_ADMIN is exempt. Throws 403 otherwise.
   */
  private assertWithinCeiling(actor: AuthUser, permissions: Record<string, string[]> | undefined, refundLimit: number | null | undefined, what: string) {
    if (actor.type === UserType.SUPER_ADMIN) return;
    for (const [m, acts] of Object.entries(permissions ?? {})) {
      for (const a of acts) if (!actor.permissions?.[m]?.includes(a)) throw new ForbiddenException(`You cannot grant ${what} you do not hold yourself (${m}:${a})`);
    }
    if (refundLimit === null) throw new ForbiddenException('Only a Super Admin can set an unlimited refund limit');
    if (refundLimit !== undefined && actor.refundLimit !== null && actor.refundLimit !== undefined && refundLimit > actor.refundLimit) {
      throw new ForbiddenException('You cannot set a refund limit above your own');
    }
  }

  private async assertCanManageUser(actor: AuthUser, target: User) {
    if (target.type === UserType.SUPER_ADMIN && actor.type !== UserType.SUPER_ADMIN) throw new ForbiddenException('Only a Super Admin can manage a Super Admin');
    if (actor.type === UserType.SUPER_ADMIN) return;
    if (target.id === actor.id) return; // self-service handled per action
    const role = target.roleId ? await this.roles.findOne({ where: { id: target.roleId } }) : null;
    if (role) this.assertWithinCeiling(actor, role.permissions, role.refundLimit, 'permissions of that account (it is more privileged than you)');
  }

  // ---- roles
  async listRoles() {
    const roles = await this.roles.find({ order: { isSystem: 'DESC', name: 'ASC' } });
    const counts: { roleId: string; n: string }[] = await this.users.query(
      `SELECT "roleId", COUNT(*) n FROM users WHERE type = 'STAFF' AND status <> 'DELETED' GROUP BY "roleId"`,
    );
    const map = new Map(counts.map((c) => [c.roleId, +c.n]));
    return roles.map((r) => ({ ...r, userCount: map.get(r.id) ?? 0 }));
  }

  async createRole(dto: RoleDto, actor: AuthUser, req: any) {
    if (StaffService.RESERVED.test(dto.name)) throw new BadRequestException('That role name is reserved');
    if (await this.roles.findOne({ where: { name: dto.name } })) throw new ConflictException('A role with this name exists');
    const permissions = this.sanitizePermissions(dto.permissions);
    this.assertWithinCeiling(actor, permissions, dto.refundLimit === undefined ? 0 : dto.refundLimit, 'permissions');
    const role = await this.roles.save(
      this.roles.create({
        name: dto.name,
        description: dto.description,
        permissions,
        refundLimit: dto.refundLimit === undefined ? 0 : dto.refundLimit,
        cityIds: dto.cityIds ?? [],
        zoneIds: dto.zoneIds ?? [],
      }),
    );
    await this.audit.logReq(req, 'role.create', 'role', role.id, undefined, role);
    return role;
  }

  async cloneRole(id: string, name: string, actor: AuthUser, req: any) {
    const src = await this.roles.findOne({ where: { id } });
    if (!src) throw new NotFoundException();
    if (StaffService.RESERVED.test(name)) throw new BadRequestException('That role name is reserved');
    this.assertWithinCeiling(actor, src.permissions, src.refundLimit, 'permissions');
    if (await this.roles.findOne({ where: { name } })) throw new ConflictException('A role with this name exists');
    const role = await this.roles.save(
      this.roles.create({
        name,
        description: src.description,
        permissions: JSON.parse(JSON.stringify(src.permissions)),
        refundLimit: src.refundLimit,
        cityIds: [...src.cityIds],
        zoneIds: [...src.zoneIds],
        isSystem: false,
      }),
    );
    await this.audit.logReq(req, 'role.clone', 'role', role.id, { sourceRoleId: id }, role);
    return role;
  }

  async updateRole(id: string, dto: UpdateRoleDto, actor: AuthUser, req: any) {
    const role = await this.roles.findOne({ where: { id } });
    if (!role) throw new NotFoundException();
    if (actor.type !== UserType.SUPER_ADMIN) {
      if (actor.roleId === id) throw new ForbiddenException('You cannot edit your own role');
      this.assertWithinCeiling(actor, role.permissions, role.refundLimit, 'permissions (this role is more privileged than yours)'); // can't touch a stronger role
      if (dto.permissions) this.assertWithinCeiling(actor, this.sanitizePermissions(dto.permissions), undefined, 'permissions');
      if (dto.refundLimit !== undefined) this.assertWithinCeiling(actor, undefined, dto.refundLimit, 'permissions');
    }
    if (dto.name && StaffService.RESERVED.test(dto.name)) throw new BadRequestException('That role name is reserved');
    const before = JSON.parse(JSON.stringify(role));
    if (dto.name && dto.name !== role.name) {
      if (await this.roles.findOne({ where: { name: dto.name } })) throw new ConflictException('A role with this name exists');
      role.name = dto.name;
    }
    if (dto.description !== undefined) role.description = dto.description;
    if (dto.permissions) role.permissions = this.sanitizePermissions(dto.permissions);
    if (dto.refundLimit !== undefined) role.refundLimit = dto.refundLimit;
    if (dto.cityIds) role.cityIds = dto.cityIds;
    if (dto.zoneIds) role.zoneIds = dto.zoneIds;
    await this.roles.save(role);
    const members = await this.users.find({ where: { roleId: id }, select: ['id'] });
    members.forEach((m) => this.strategy.invalidate(m.id));
    await this.audit.logReq(req, 'security.role_permissions_changed', 'role', id, before, role);
    return role;
  }

  async deleteRole(id: string, actor: AuthUser, req: any) {
    const role = await this.roles.findOne({ where: { id } });
    if (!role) throw new NotFoundException();
    this.assertWithinCeiling(actor, role.permissions, role.refundLimit, 'permissions (this role is more privileged than yours)');
    if (role.isSystem) throw new ForbiddenException('System roles cannot be deleted (clone them instead)');
    const inUse = await this.users.count({ where: { roleId: id } });
    if (inUse) throw new ConflictException(`${inUse} staff member(s) still use this role`);
    await this.roles.delete(id);
    await this.audit.logReq(req, 'role.delete', 'role', id, role);
    return { ok: true };
  }

  // ---- staff
  listStaff(q: StaffQuery) {
    const qb = this.users
      .createQueryBuilder('u')
      .leftJoinAndSelect('u.role', 'role')
      .where('u.type IN (:...types)', { types: [UserType.STAFF, UserType.SUPER_ADMIN] })
      .andWhere('u.status <> :del', { del: UserStatus.DELETED });
    if (q.roleId) qb.andWhere('u.roleId = :rid', { rid: q.roleId });
    if (q.status) qb.andWhere('u.status = :st', { st: q.status });
    if (q.search) {
      qb.andWhere(
        new Brackets((b) =>
          b
            .where('u.email ILIKE :s', { s: like(q.search!) })
            .orWhere('u.firstName ILIKE :s', { s: like(q.search!) })
            .orWhere('u.lastName ILIKE :s', { s: like(q.search!) }),
        ),
      );
    }
    return paginateQb(qb, q, {
      sortable: { createdAt: 'u.createdAt', firstName: 'u.firstName', email: 'u.email', lastLoginAt: 'u.lastLoginAt' },
      defaultSort: ['u.createdAt', 'DESC'],
    });
  }

  private toView(u: User) {
    const { passwordHash, twoFactorSecret, ...rest } = u as any;
    return rest;
  }

  async createStaff(dto: CreateStaffDto, actor: AuthUser, req: any) {
    const email = dto.email.toLowerCase();
    if (await this.users.findOne({ where: { email } })) throw new ConflictException('Email already in use');
    if (dto.superAdmin && actor.type !== UserType.SUPER_ADMIN) throw new ForbiddenException('Only a Super Admin can create Super Admins');
    if (!dto.superAdmin) {
      if (!dto.roleId) throw new BadRequestException('roleId is required');
      const role = await this.roles.findOne({ where: { id: dto.roleId } });
      if (!role) throw new BadRequestException('Unknown role');
      this.assertWithinCeiling(actor, role.permissions, role.refundLimit, 'permissions (that role is more privileged than yours)');
    }
    const tempPassword = dto.password ?? `${randomBytes(9).toString('base64url')}#${randomInt(10, 99)}`;
    const user = await this.users.save(
      this.users.create({
        type: dto.superAdmin ? UserType.SUPER_ADMIN : UserType.STAFF,
        status: UserStatus.ACTIVE,
        email,
        phone: dto.phone ?? null,
        firstName: dto.firstName,
        lastName: dto.lastName,
        roleId: dto.superAdmin ? null : dto.roleId,
        emailVerified: true,
        passwordHash: await bcrypt.hash(tempPassword, 12),
      }),
    );
    await this.audit.logReq(req, dto.superAdmin ? 'security.super_admin_created' : 'staff.create', 'user', user.id, undefined, { email, roleId: dto.roleId, superAdmin: !!dto.superAdmin });
    this.notifications
      .sendEmail(email, 'Your FORKSY admin account', `Hi ${dto.firstName}, your FORKSY admin account was created. Temporary password: ${tempPassword}. You will be asked to set up two-factor authentication at first sign-in.`)
      .catch(() => undefined);
    return { user: this.toView(user), temporaryPassword: dto.password ? undefined : tempPassword };
  }

  async getStaff(id: string) {
    const u = await this.users.findOne({ where: { id, type: In([UserType.STAFF, UserType.SUPER_ADMIN]) }, relations: ['role'] });
    if (!u) throw new NotFoundException();
    return this.toView(u);
  }

  async updateStaff(id: string, dto: UpdateStaffDto, actor: AuthUser, req: any) {
    const u = await this.users.findOne({ where: { id, type: In([UserType.STAFF, UserType.SUPER_ADMIN]) } });
    if (!u) throw new NotFoundException();
    await this.assertCanManageUser(actor, u);
    if (u.id === actor.id && dto.status && dto.status !== UserStatus.ACTIVE) throw new BadRequestException('You cannot deactivate yourself');
    if (dto.roleId) {
      if (u.id === actor.id && actor.type !== UserType.SUPER_ADMIN) throw new ForbiddenException('You cannot change your own role');
      const newRole = await this.roles.findOne({ where: { id: dto.roleId } });
      if (!newRole) throw new BadRequestException('Unknown role');
      this.assertWithinCeiling(actor, newRole.permissions, newRole.refundLimit, 'permissions (that role is more privileged than yours)');
    }
    const before = this.toView(u);
    Object.assign(u, Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined)));
    await this.users.save(u);
    if (dto.status && dto.status !== UserStatus.ACTIVE) {
      await this.tokens.update({ userId: id, revokedAt: IsNull() }, { revokedAt: new Date() });
      await this.users.update(id, { tokensValidAfter: new Date(), tokenVersion: () => '"tokenVersion" + 1' });
    }
    this.strategy.invalidate(id);
    await this.audit.logReq(req, dto.roleId ? 'security.staff_role_change' : 'staff.update', 'user', id, before, this.toView(u));
    return this.toView(u);
  }

  async resetPassword(id: string, actor: AuthUser, req: any) {
    const u = await this.users.findOne({ where: { id, type: In([UserType.STAFF, UserType.SUPER_ADMIN]) } });
    if (!u) throw new NotFoundException();
    await this.assertCanManageUser(actor, u);
    if (u.id === actor.id) throw new BadRequestException('Use change password for your own account');
    const tmp = `${randomBytes(9).toString('base64url')}#${randomInt(10, 99)}`;
    await this.users.update(id, { passwordHash: await bcrypt.hash(tmp, 12), passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null, tokensValidAfter: new Date(), tokenVersion: () => '"tokenVersion" + 1' });
    await this.tokens.update({ userId: id, revokedAt: IsNull() }, { revokedAt: new Date() });
    this.strategy.invalidate(id);
    await this.audit.logReq(req, 'security.staff_password_reset', 'user', id);
    return { temporaryPassword: tmp };
  }

  async reset2fa(id: string, actor: AuthUser, req: any) {
    const u = await this.users.findOne({ where: { id, type: In([UserType.STAFF, UserType.SUPER_ADMIN]) } });
    if (!u) throw new NotFoundException();
    await this.assertCanManageUser(actor, u);
    if (u.id === actor.id) throw new BadRequestException('You cannot reset your own 2FA');
    await this.users.update(id, { twoFactorEnabled: false, twoFactorSecret: null, tokensValidAfter: new Date(), tokenVersion: () => '"tokenVersion" + 1' });
    this.strategy.invalidate(id);
    await this.audit.logReq(req, 'security.staff_2fa_reset', 'user', id);
    return { ok: true };
  }

  async revokeSessions(id: string, actor: AuthUser, req: any) {
    const u = await this.users.findOne({ where: { id, type: In([UserType.STAFF, UserType.SUPER_ADMIN]) } });
    if (!u) throw new NotFoundException();
    await this.assertCanManageUser(actor, u);
    await this.tokens.update({ userId: id, revokedAt: IsNull() }, { revokedAt: new Date() });
    await this.users.update(id, { tokensValidAfter: new Date(), tokenVersion: () => '"tokenVersion" + 1' });
    this.strategy.invalidate(id);
    await this.audit.logReq(req, 'staff.revoke_sessions', 'user', id);
    return { ok: true };
  }

  async removeStaff(id: string, actor: AuthUser, req: any) {
    const u = await this.users.findOne({ where: { id, type: In([UserType.STAFF, UserType.SUPER_ADMIN]) } });
    if (!u) throw new NotFoundException();
    if (u.id === actor.id) throw new BadRequestException('You cannot delete yourself');
    await this.assertCanManageUser(actor, u);
    if (u.type === UserType.SUPER_ADMIN) {
      if (actor.type !== UserType.SUPER_ADMIN) throw new ForbiddenException();
      const supers = await this.users.count({ where: { type: UserType.SUPER_ADMIN, status: UserStatus.ACTIVE } });
      if (supers <= 1) throw new BadRequestException('Cannot remove the last Super Admin');
    }
    // SOP-09: remove access the same day; keep the row for audit integrity
    await this.users.update(id, { status: UserStatus.DELETED, deletedAt: new Date(), email: `deleted+${id}@forksy.invalid`, phone: null });
    await this.tokens.update({ userId: id, revokedAt: IsNull() }, { revokedAt: new Date() });
    await this.users.update(id, { tokensValidAfter: new Date(), tokenVersion: () => '"tokenVersion" + 1' });
    this.strategy.invalidate(id);
    await this.audit.logReq(req, 'staff.remove', 'user', id, { email: u.email });
    return { ok: true };
  }

  /** SOP-09 quarterly access review: export the user-role list. */
  async accessReview() {
    const rows = await this.users
      .createQueryBuilder('u')
      .leftJoin('u.role', 'r')
      .select([
        'u.id AS id',
        'u.email AS email',
        `TRIM(u."firstName" || ' ' || u."lastName") AS name`,
        'u.type AS type',
        'u.status AS status',
        'r.name AS role',
        'u.lastLoginAt AS "lastLoginAt"',
        'u.twoFactorEnabled AS "twoFactorEnabled"',
      ])
      .where('u.type IN (:...t)', { t: [UserType.STAFF, UserType.SUPER_ADMIN] })
      .andWhere('u.status <> :d', { d: UserStatus.DELETED })
      .orderBy('u.email')
      .getRawMany();
    const cutoff = Date.now() - 90 * 86400_000;
    return rows.map((r) => ({ ...r, inactive90d: !r.lastLoginAt || new Date(r.lastLoginAt).getTime() < cutoff }));
  }
}

// ------------------------------------------------------------------ controllers
@AdminController('roles')
class RolesController {
  constructor(private svc: StaffService) {}

  /** Module x action matrix definition for the permission editor. */
  @Get('meta')
  @Permission(Mod.ROLES, Action.VIEW)
  meta() {
    return { modules: ALL_MODULES, actions: Object.values(Action) };
  }

  @Get()
  @Permission(Mod.ROLES, Action.VIEW)
  async list() {
    return { data: await this.svc.listRoles() };
  }

  @Post()
  @Permission(Mod.ROLES, Action.CREATE)
  create(@Body() dto: RoleDto, @CurrentUser() u: AuthUser, @Req() req: any) {
    return this.svc.createRole(dto, u, req);
  }

  @Post(':id/clone')
  @Permission(Mod.ROLES, Action.CREATE)
  clone(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CloneRoleDto, @CurrentUser() u: AuthUser, @Req() req: any) {
    return this.svc.cloneRole(id, dto.name, u, req);
  }

  @Patch(':id')
  @Permission(Mod.ROLES, Action.EDIT)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateRoleDto, @CurrentUser() u: AuthUser, @Req() req: any) {
    return this.svc.updateRole(id, dto, u, req);
  }

  @Delete(':id')
  @Permission(Mod.ROLES, Action.DELETE)
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() req: any) {
    return this.svc.deleteRole(id, u, req);
  }
}

@AdminController('staff')
class StaffController {
  constructor(private svc: StaffService) {}

  @Get()
  @Permission(Mod.STAFF, Action.VIEW)
  list(@Query() q: StaffQuery) {
    return this.svc.listStaff(q);
  }

  @Get('access-review')
  @Permission(Mod.STAFF, Action.EXPORT)
  async review() {
    return { data: await this.svc.accessReview() };
  }

  @Get(':id')
  @Permission(Mod.STAFF, Action.VIEW)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.getStaff(id);
  }

  @Post()
  @Permission(Mod.STAFF, Action.CREATE)
  create(@Body() dto: CreateStaffDto, @CurrentUser() u: AuthUser, @Req() req: any) {
    return this.svc.createStaff(dto, u, req);
  }

  @Patch(':id')
  @Permission(Mod.STAFF, Action.EDIT)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateStaffDto, @CurrentUser() u: AuthUser, @Req() req: any) {
    return this.svc.updateStaff(id, dto, u, req);
  }

  @Post(':id/reset-password')
  @Permission(Mod.STAFF, Action.EDIT)
  resetPw(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() req: any) {
    return this.svc.resetPassword(id, u, req);
  }

  @Post(':id/reset-2fa')
  @Permission(Mod.STAFF, Action.EDIT)
  reset2fa(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() req: any) {
    return this.svc.reset2fa(id, u, req);
  }

  @Post(':id/revoke-sessions')
  @Permission(Mod.STAFF, Action.EDIT)
  revoke(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() req: any) {
    return this.svc.revokeSessions(id, u, req);
  }

  @Delete(':id')
  @Permission(Mod.STAFF, Action.DELETE)
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() req: any) {
    return this.svc.removeStaff(id, u, req);
  }
}

@Module({
  imports: [TypeOrmModule.forFeature([User, Role, RefreshToken])],
  providers: [StaffService],
  controllers: [RolesController, StaffController],
  exports: [StaffService],
})
export class StaffModule {}
