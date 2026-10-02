import { applyDecorators, Controller, createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Action, Module, RestaurantRole, UserType } from './enums';
import { AuthUser } from './auth.types';
import { clientIp } from './security';

export const IS_PUBLIC = 'isPublic';
export const USER_TYPES = 'userTypes';
export const PERMISSION = 'permission';
export const RESTAURANT_ROLES = 'restaurantRoles';
export const ALLOW_2FA_PENDING = 'allow2faPending';

/** Route may be called with the limited token issued between password check and 2FA. */
export const Allow2faPending = () => SetMetadata(ALLOW_2FA_PENDING, true);

export const NO_IMPERSONATION = 'noImpersonation';

/** Route is refused for impersonation tokens (password / 2FA / account security). */
export const NoImpersonation = () => SetMetadata(NO_IMPERSONATION, true);

/** Skip authentication. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Restrict a route/controller to certain user types. */
export const UserTypes = (...types: UserType[]) => SetMetadata(USER_TYPES, types);

/** STAFF permission: @Permission(Module.ORDERS, Action.VIEW). SUPER_ADMIN always passes. */
export const Permission = (module: Module, action: Action) => SetMetadata(PERMISSION, { module, action });

/** Restaurant-side role restriction: @RestaurantRoles(OWNER, LOCATION_MANAGER) */
export const RestaurantRoles = (...roles: RestaurantRole[]) => SetMetadata(RESTAURANT_ROLES, roles);

export const CurrentUser = createParamDecorator((data: keyof AuthUser | undefined, ctx: ExecutionContext) => {
  const user: AuthUser = ctx.switchToHttp().getRequest().user;
  return data ? user?.[data] : user;
});

export const ClientIp = createParamDecorator((_d, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest();
  return clientIp(req);
});

/** /api/v1/admin/<path> - staff + super admin only (use @Permission on handlers). */
export const AdminController = (path = '') =>
  applyDecorators(
    Controller(`admin/${path}`),
    UserTypes(UserType.STAFF, UserType.SUPER_ADMIN),
    ApiTags(`Admin / ${path || 'root'}`),
    ApiBearerAuth(),
  );

/** /api/v1/restaurant/<path> - restaurant portal & tablet KDS. */
export const RestaurantController = (path = '') =>
  applyDecorators(
    Controller(`restaurant/${path}`),
    UserTypes(UserType.RESTAURANT),
    ApiTags(`Restaurant / ${path || 'root'}`),
    ApiBearerAuth(),
  );

/** /api/v1/driver/<path> - driver mobile app. */
export const DriverController = (path = '') =>
  applyDecorators(
    Controller(`driver/${path}`),
    UserTypes(UserType.DRIVER),
    ApiTags(`Driver / ${path || 'root'}`),
    ApiBearerAuth(),
  );

/** /api/v1/customer/<path> - customer mobile app & website. */
export const CustomerController = (path = '') =>
  applyDecorators(
    Controller(`customer/${path}`),
    UserTypes(UserType.CUSTOMER),
    ApiTags(`Customer / ${path || 'root'}`),
    ApiBearerAuth(),
  );

/** /api/v1/public/<path> - no auth. */
export const PublicController = (path = '') =>
  applyDecorators(Controller(`public/${path}`), Public(), ApiTags(`Public / ${path || 'root'}`));
