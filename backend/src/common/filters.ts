import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { clientIp } from './security';

const isProd = () => process.env.NODE_ENV === 'production';

@Catch()
@Injectable()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');
  private rateLogged = new Map<string, number>();

  constructor(private audit: AuditService) {}

  catch(exception: any, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse();
    const req = ctx.getRequest();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: any = 'Internal server error';
    let details: any;
    let exCode: string | undefined;
    let extra: Record<string, any> = {};

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const r: any = exception.getResponse();
      message = typeof r === 'string' ? r : r.message ?? exception.message;
      if (r && typeof r === 'object') {
        if (r.details !== undefined) details = r.details;
        if (r.code) exCode = r.code;
        if (r.retryAfterSeconds) extra.retryAfterSeconds = r.retryAfterSeconds;
      }
      if (Array.isArray(message)) {
        details = message;
        message = 'Validation failed';
      }
      // never echo stack traces / SQL / file paths that a lower layer wrapped into an HttpException message
      if (status >= 500 && isProd()) message = 'Internal server error';
    } else if (exception?.type === 'entity.too.large' || exception?.status === 413) {
      status = HttpStatus.PAYLOAD_TOO_LARGE;
      message = 'Request body too large';
    } else if (exception?.type === 'entity.parse.failed' || exception?.status === 400) {
      status = HttpStatus.BAD_REQUEST;
      message = 'Malformed request body';
    } else if (exception?.code === '23505') {
      status = HttpStatus.CONFLICT;
      message = isProd() ? 'Duplicate value: a record with these details already exists' : 'Duplicate value: ' + (exception.detail ?? 'unique constraint violated');
    } else if (exception?.code === '23503') {
      status = HttpStatus.CONFLICT;
      message = 'Cannot complete: record is referenced by, or references, other data';
    } else if (exception?.code === '22P02' || exception?.code === '22003' || exception?.code === '22007' || exception?.code === '22008') {
      status = HttpStatus.BAD_REQUEST;
      message = 'Invalid identifier or value';
    } else if (exception?.code === '57014') {
      status = HttpStatus.SERVICE_UNAVAILABLE;
      message = 'The request took too long and was cancelled. Narrow the filters and try again.';
    } else if (exception instanceof RangeError && /Invalid time value|Invalid Date|Invalid array length/i.test(exception.message)) {
      status = HttpStatus.BAD_REQUEST;
      message = 'Invalid date or value';
    } else if (exception?.name === 'EntityNotFoundError') {
      status = HttpStatus.NOT_FOUND;
      message = 'Not found';
    } else if (exception?.name === 'MulterError') {
      status = exception.code === 'LIMIT_FILE_SIZE' ? HttpStatus.PAYLOAD_TOO_LARGE : HttpStatus.BAD_REQUEST;
      message = exception.code === 'LIMIT_FILE_SIZE' ? 'File too large' : 'Invalid upload';
    }

    if (status >= 500) this.logger.error(`${req.method} ${this.safeUrl(req)} -> ${exception?.stack ?? exception}`);

    if (status === 429) this.auditRateLimit(req);
    if (status === 401 || status === 403) this.auditDenied(req, status);

    // never reflect the raw URL (could carry attacker markup / tokens in query strings)
    res.status(status).json({
      statusCode: status,
      message,
      ...(exCode ? { code: exCode } : {}),
      ...extra,
      details,
      path: this.safeUrl(req),
      timestamp: new Date().toISOString(),
    });
  }

  private safeUrl(req: any) {
    return String(req.originalUrl ?? req.url ?? '').split('?')[0].slice(0, 200);
  }

  /** Rate-limit hits are security events - one audit row per tracker per minute (no log flooding). */
  private auditRateLimit(req: any) {
    const key = req._rateLimited?.tracker ?? clientIp(req);
    const now = Date.now();
    if (now - (this.rateLogged.get(key) ?? 0) < 60_000) return;
    this.rateLogged.set(key, now);
    if (this.rateLogged.size > 5000) for (const [k, t] of this.rateLogged) if (now - t > 60_000) this.rateLogged.delete(k);
    this.audit
      .log({ actor: req.user ?? null, action: 'security.rate_limited', ip: clientIp(req), userAgent: req.headers?.['user-agent'], path: this.safeUrl(req), method: req.method, after: { tracker: key } })
      .catch(() => undefined);
  }

  /** Authenticated access-control denials (403 on someone's token) are worth keeping: probing / IDOR attempts. */
  private auditDenied(req: any, status: number) {
    if (status !== 403 || !req.user) return;
    const key = `403:${req.user.id}`;
    const now = Date.now();
    if (now - (this.rateLogged.get(key) ?? 0) < 60_000) return;
    this.rateLogged.set(key, now);
    this.audit
      .log({ actor: req.user, action: 'security.access_denied', ip: clientIp(req), userAgent: req.headers?.['user-agent'], path: this.safeUrl(req), method: req.method })
      .catch(() => undefined);
  }
}
