import { RestaurantRole, UserType } from './enums';

export interface JwtPayload {
  sub: string;
  type: UserType;
  sid?: string;
  iat?: number;
  exp?: number;
  /** true while the user still has to pass the 2FA step (limited token) */
  pending2fa?: boolean;
  /** admin user id when this is an impersonation (support "view as owner") token */
  imp?: string;
}

/** What controllers receive through @CurrentUser(). Built in JwtStrategy.validate(). */
export interface AuthUser {
  id: string;
  type: UserType;
  email: string | null;
  phone: string | null;
  name: string;
  status: string;

  /** STAFF: role info. SUPER_ADMIN bypasses all permission checks. */
  roleId?: string | null;
  roleName?: string | null;
  permissions?: Record<string, string[]>;
  refundLimit?: number | null; // null = unlimited
  scopeCityIds?: string[];
  scopeZoneIds?: string[];

  /** RESTAURANT users */
  merchantId?: string;
  restaurantRole?: RestaurantRole;
  /** restaurant location ids this user may access (owner => all of the merchant's locations) */
  restaurantIds?: string[];

  /** DRIVER users: DriverProfile.id */
  driverId?: string;

  /** CUSTOMER users: same as id */
  customerId?: string;

  /** Set when an admin is acting as this user via POST /admin/restaurants/:id/impersonate (admin's user id). */
  impersonatedBy?: string;
}
