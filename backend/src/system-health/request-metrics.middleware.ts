import { SystemMetricsService } from './system-metrics.service';

/** Requests that must not count as "traffic": liveness probes, the health page itself, websocket polling. */
const EXCLUDED = [/^\/api\/v1\/health(\/|\?|$)/, /^\/api\/v1\/ready(\/|\?|$)/, /^\/api\/v1\/admin\/system\//, /^\/socket\.io\//];

/**
 * Express middleware (registered in main.ts before the routes): records status code and duration of every API request.
 * Route keys are the matched route PATTERN ("GET /api/v1/admin/orders/:id"), never the raw URL, so ids and query strings can
 * neither blow up the cardinality nor leak into the health page. Unmatched paths (404s, scanners) share one key.
 */
export function requestMetricsMiddleware(metrics: SystemMetricsService) {
  return (req: any, res: any, next: () => void) => {
    const url: string = req.originalUrl || req.url || '';
    if (EXCLUDED.some((re) => re.test(url))) return next();
    const started = process.hrtime.bigint();
    let done = false;
    metrics.requestStarted();
    const finish = () => {
      if (done) return;
      done = true;
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      let route: string;
      if (req.route?.path) route = `${req.method} ${(req.baseUrl || '') + String(req.route.path)}`;
      else if (url.startsWith('/uploads/')) route = `${req.method} /uploads/*`;
      else route = `${req.method} (unmatched)`;
      metrics.requestFinished(route, res.statusCode, ms);
    };
    res.once('finish', finish);
    res.once('close', finish); // client went away before the response finished
    next();
  };
}
