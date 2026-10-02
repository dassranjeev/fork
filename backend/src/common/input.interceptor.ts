import { BadRequestException, CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { DEFAULT_LIMITS, InputRejected, sanitizeDeep } from './security';

/** admin endpoints whose body / answer fields may legitimately contain formatted (HTML) text */
const RICH_ROUTE = /^\/api\/v1\/admin\/(cms-pages|faqs)(\/|$)/;
const RICH_KEYS = /^(body|answer|content)$/i;

/**
 * Global input hardening, runs after guards and BEFORE the ValidationPipe:
 *  - rejects prototype-pollution keys (__proto__ / constructor / prototype), absurd nesting / array / string sizes
 *  - strips HTML tags, <script>/<style> bodies, control + bidi characters from every free-text string (stored XSS defence in depth)
 *  - requires http(s)/site-relative URLs for fields named *url / *link / avatar / image / photo / logo ... (blocks javascript:, data:)
 *  - passwords / tokens / codes are left untouched
 * Fields that legitimately carry HTML (named bodyHtml / contentHtml / html) go through the strict sanitize-html allow-list instead.
 */
@Injectable()
export class InputSanitizerInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<any> {
    if (ctx.getType() !== 'http') return next.handle();
    const req = ctx.switchToHttp().getRequest();
    const ct = String(req.headers['content-type'] ?? '');
    try {
      const rich = RICH_ROUTE.test(String(req.path ?? '')) ? RICH_KEYS : undefined;
      if (req.body && typeof req.body === 'object' && !ct.startsWith('multipart/')) req.body = sanitizeDeep(req.body, '', 0, DEFAULT_LIMITS, '', rich);
      if (req.query && Object.keys(req.query).length) {
        const q = sanitizeDeep({ ...req.query });
        for (const [k, min, max] of [['page', 1, 10_000], ['limit', 1, 1000]] as const) {
          if (q[k] === undefined) continue;
          const n = Number(q[k]);
          if (!/^\d{1,6}$/.test(String(q[k])) || n < min || n > max) throw new InputRejected(k, `must be an integer between ${min} and ${max}`);
        }
        // Express 5: req.query is a getter - redefine it
        Object.defineProperty(req, 'query', { value: q, writable: true, configurable: true, enumerable: true });
      }
    } catch (e) {
      if (e instanceof InputRejected) throw new BadRequestException(`Invalid input - ${e.message}`);
      throw e;
    }
    return next.handle();
  }
}
