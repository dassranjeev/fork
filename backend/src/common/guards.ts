import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { Observable } from 'rxjs';
import { ALLOW_2FA_PENDING, IS_PUBLIC, PERMISSION, RESTAURANT_ROLES, USER_TYPES } from './decorators';
import { AuthUser } from './auth.types';
import { Action, Module, RestaurantRole, UserType } from './enums';

/** Global: every route needs a valid JWT unless @Public(). */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private reflector: Reflector) {
    super();
  }

  canActivate(ctx: ExecutionContext): boolean | Promise<boolean> | Observable<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;
    return super.canActivate(ctx);
  }

  handleRequest(err: any, user: any, _info: any, ctx: ExecutionContext) {
    if (err || !user) throw err || new UnauthorizedException();
    if (user.pending2fa) {
      const allowed = this.reflector.getAllAndOverride<boolean>(ALLOW_2FA_PENDING, [ctx.getHandler(), ctx.getClass()]);
      if (!allowed) throw new UnauthorizedException('Two-factor authentication required');
    }
    return user;
  }
}

/** Global: enforces @UserTypes(...). */
@Injectable()
export class UserTypesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;
    const types = this.reflector.getAllAndOverride<UserType[]>(USER_TYPES, [ctx.getHandler(), ctx.getClass()]);
    if (!types?.length) return true;
    const user: AuthUser = ctx.switchToHttp().getRequest().user;
    if (!user || !types.includes(user.type)) throw new ForbiddenException('Not allowed for this account type');
    return true;
  }
}

export function hasPermission(user: AuthUser, module: Module | string, action: Action | string): boolean {
  if (user.type === UserType.SUPER_ADMIN) return true;
  if (user.type !== UserType.STAFF) return false;
  return !!user.permissions?.[module]?.includes(action);
}

/** Global: enforces @Permission(module, action) for staff. */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;
    const perm = this.reflector.getAllAndOverride<{ module: Module; action: Action }>(PERMISSION, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!perm) return true;
    const user: AuthUser = ctx.switchToHttp().getRequest().user;
    if (!user || !hasPermission(user, perm.module, perm.action)) {
      throw new ForbiddenException(`Missing permission: ${perm.module}:${perm.action}`);
    }
    return true;
  }
}

/** Global: enforces @RestaurantRoles(...). */
@Injectable()
export class RestaurantRolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<RestaurantRole[]>(RESTAURANT_ROLES, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!roles?.length) return true;
    const user: AuthUser = ctx.switchToHttp().getRequest().user;
    if (!user || user.type !== UserType.RESTAURANT || !roles.includes(user.restaurantRole)) {
      throw new ForbiddenException('Your restaurant role does not allow this action');
    }
    return true;
  }
}
