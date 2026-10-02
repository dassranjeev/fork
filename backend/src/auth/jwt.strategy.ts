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
type Cached = { at: number; user: AuthUser; tva: number; tv: number };

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private cache = new Map<string, Cached>();

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
      algorithms: ['HS256'], // pinned: no alg=none, no RS/HS confusion
      issuer: config.get<string>('jwt.issuer'),
      audience: config.get<string>('jwt.audience'),
    });
  }

  /** Tokens issued before logout-all / password change / block are dead (iat compared at 1 s resolution). */
  private assertFresh(payload: JwtPayload, tva: number, tv: number) {
    if ((payload.tv ?? 0) !== tv) throw new UnauthorizedException('Session expired, sign in again');
    if (tva && payload.iat !== undefined && payload.iat < Math.floor(tva / 1000)) throw new UnauthorizedException('Session expired, sign in again');
  }

  invalidate(userId: string) {
    this.cache.delete(userId);
  }

  async validate(payload: JwtPayload): Promise<AuthUser & { pending2fa?: boolean }> {
    const hit = this.cache.get(payload.sub);
    if (hit && Date.now() - hit.at < CACHE_MS) {
      this.assertFresh(payload, hit.tva, hit.tv);
      return { ...hit.user, pending2fa: payload.pending2fa, ...(payload.imp ? { impersonatedBy: payload.imp } : {}) };
    }

    const user = await this.users.findOne({ where: { id: payload.sub } });
    if (!user) throw new UnauthorizedException();
    if (user.status === UserStatus.BLOCKED || user.status === UserStatus.DELETED || user.status === UserStatus.SUSPENDED) {
      throw new UnauthorizedException('Account is not active');
    }
    const tva = user.tokensValidAfter ? user.tokensValidAfter.getTime() : 0;
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
    const tv = user.tokenVersion ?? 0;
    this.cache.set(user.id, { at: Date.now(), user: au, tva, tv });
    this.assertFresh(payload, tva, tv);
    return { ...au, pending2fa: payload.pending2fa, ...(payload.imp ? { impersonatedBy: payload.imp } : {}) };
  }
}
