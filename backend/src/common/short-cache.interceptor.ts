import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, from, of } from 'rxjs';

/**
 * Micro-cache + single-flight for expensive read endpoints (analytics / dashboards):
 *  - identical GETs by the same user within TTL_MS are answered from memory (the dashboard polls every ~30 s, so users
 *    still see fresh numbers, but a burst of refreshes - or an attacker hammering a heavy endpoint - hits the DB once)
 *  - concurrent identical requests share ONE in-flight query
 * Keyed by user id + full URL, so one user's scoped data can never be served to another.
 */
const TTL_MS = 5_000;
const MAX_ENTRIES = 500;

@Injectable()
export class ShortCacheInterceptor implements NestInterceptor {
  private done = new Map<string, { at: number; value: any }>();
  private inflight = new Map<string, Promise<any>>();

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<any> {
    const req = ctx.switchToHttp().getRequest();
    if (req.method !== 'GET' || !req.user?.id) return next.handle();
    const key = `${req.user.id}|${req.originalUrl}`;
    const now = Date.now();
    const hit = this.done.get(key);
    if (hit && now - hit.at < TTL_MS) return of(hit.value);
    const pending = this.inflight.get(key);
    if (pending) return from(pending);
    const p = new Promise<any>((resolve, reject) => {
      next.handle().subscribe({
        next: (v) => {
          if (this.done.size >= MAX_ENTRIES) {
            for (const [k, e] of this.done) if (now - e.at >= TTL_MS) this.done.delete(k);
            if (this.done.size >= MAX_ENTRIES) this.done.clear();
          }
          this.done.set(key, { at: Date.now(), value: v });
          resolve(v);
        },
        error: (e) => reject(e),
      });
    }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return from(p);
  }
}
