import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { InjectRepository } from '@nestjs/typeorm';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Repository } from 'typeorm';
import { DriverProfile, Restaurant, RestaurantMember, Role, User } from '../database/entities';
import { AuthUser, JwtPayload } from '../common/auth.types';
import { RestaurantRole, UserStatus, UserType } from '../common/enums';

/** Short-lived cache so we don't hit the DB on every request. */
const CACHE_MS = 10_000;

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private cache = new Map<string, { at: number; user: AuthUser }>();

  constructor(
    config: ConfigService,
    @InjectRepository(User) private users: Repository<User>,
    @InjectRepository(Role) private roles: Repository<Role>,
    @InjectRepository(DriverProfile) private drivers: Repository<DriverProfile>,
    @InjectRepository(RestaurantMember) private members: Repository<RestaurantMember>,
    @InjectRepository(Restaurant) private restaurants: Repository<Restaurant>,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('jwt.secret'),
    });
  }

  invalidate(userId: string) {
    this.cache.delete(userId);
  }

  async validate(payload: JwtPayload): Promise<AuthUser & { pending2fa?: boolean }> {
    const hit = this.cache.get(payload.sub);
    if (hit && Date.now() - hit.at < CACHE_MS) return { ...hit.user, pending2fa: payload.pending2fa, ...(payload.imp ? { impersonatedBy: payload.imp } : {}) };

    const user = await this.users.findOne({ where: { id: payload.sub } });
    if (!user) throw new UnauthorizedException();
    if (user.status === UserStatus.BLOCKED || user.status === UserStatus.DELETED || user.status === UserStatus.SUSPENDED) {
      throw new UnauthorizedException('Account is not active');
    }
    const au: AuthUser = {
      id: user.id,
      type: user.type,
      email: user.email,
      phone: user.phone,
      name: `${user.firstName} ${user.lastName}`.trim(),
      status: user.status,
    };

    if (user.type === UserType.STAFF) {
      const role = user.roleId ? await this.roles.findOne({ where: { id: user.roleId } }) : null;
      au.roleId = role?.id ?? null;
      au.roleName = role?.name ?? null;
      au.permissions = role?.permissions ?? {};
      au.refundLimit = role ? role.refundLimit : 0;
      au.scopeCityIds = role?.cityIds ?? [];
      au.scopeZoneIds = role?.zoneIds ?? [];
    } else if (user.type === UserType.SUPER_ADMIN) {
      au.roleName = 'Super Admin';
      au.refundLimit = null;
      au.permissions = {};
    } else if (user.type === UserType.DRIVER) {
      const dp = await this.drivers.findOne({ where: { userId: user.id } });
      au.driverId = dp?.id;
    } else if (user.type === UserType.CUSTOMER) {
      au.customerId = user.id;
    } else if (user.type === UserType.RESTAURANT) {
      const ms = await this.members.find({ where: { userId: user.id, active: true } });
      const m = ms.find((x) => x.role === RestaurantRole.OWNER) ?? ms[0];
      if (m) {
        au.merchantId = m.merchantId;
        au.restaurantRole = m.role;
        if (m.role === RestaurantRole.OWNER) {
          const rs = await this.restaurants.find({ where: { merchantId: m.merchantId }, select: ['id'] });
          au.restaurantIds = rs.map((r) => r.id);
        } else {
          au.restaurantIds = ms.filter((x) => x.restaurantId).map((x) => x.restaurantId as string);
        }
      } else {
        au.restaurantIds = [];
      }
    }
    this.cache.set(user.id, { at: Date.now(), user: au });
    return { ...au, pending2fa: payload.pending2fa, ...(payload.imp ? { impersonatedBy: payload.imp } : {}) };
  }
}
