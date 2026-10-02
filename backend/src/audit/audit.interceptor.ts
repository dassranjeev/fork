import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { AuditService } from './audit.service';
import { UserType } from '../common/enums';
import { clientIp } from '../common/security';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Global: writes an audit row for every successful mutating request by staff / super admin
 * (and restaurant users). Handlers that know before/after values call AuditService.log() as well.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private audit: AuditService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<any> {
    if (ctx.getType() !== 'http') return next.handle();
    const req = ctx.switchToHttp().getRequest();
    if (!MUTATING.has(req.method)) return next.handle();
    const url: string = req.originalUrl ?? '';
    if (url.includes('/auth/') && !url.includes('/auth/2fa')) return next.handle(); // auth logs itself
    return next.handle().pipe(
      tap({
        next: () => {
          const u = req.user;
          if (!u || ![UserType.STAFF, UserType.SUPER_ADMIN, UserType.RESTAURANT].includes(u.type)) return;
          const route = (req.route?.path as string) ?? url;
          this.audit.log({
            actor: u,
            action: `http.${req.method.toLowerCase()} ${route}`,
            entity: undefined,
            entityId: req.params?.id,
            after: { params: req.params, body: req.body },
            ip: clientIp(req),
            userAgent: req.headers['user-agent'],
            path: url,
            method: req.method,
          });
        },
      }),
    );
  }
}
