import { AssistantConfigService } from './assistant-config.service';

const API = /^\/api\/v1\/public\/assistant(\/|$)/;

/**
 * Dynamic CORS for the public assistant endpoints ONLY (every other route keeps the static CORS_ORIGINS policy).
 * Third-party merchant sites call the API cross-origin, so the allowed origin is looked up per request:
 *   allowed = origin of the FORKY web apps (CORS_ORIGINS) or an origin in ANY enabled restaurant's allowedOrigins (cached, refreshed every
 *             60 s and whenever a configuration is saved).
 * The handlers then check the exact restaurant (botKey + Origin) - this layer only decides whether the BROWSER may read the answer.
 * `*` is never used for the chat endpoints. The widget script itself is public and may be loaded from any website.
 *
 * Must be registered BEFORE app.enableCors() so that preflights of these paths are answered here.
 */
export function assistantCors(cfg: AssistantConfigService) {
  return (req: any, res: any, next: () => void) => {
    const path: string = req.path ?? '';
    if (path === '/assistant/widget.js') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Max-Age', '600');
        return res.status(204).end();
      }
      return next();
    }
    if (!API.test(path)) return next();
    res.vary('Origin');
    const origin = req.headers.origin as string | undefined;
    const allowed = !!origin && cfg.originInUnion(origin);
    if (allowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Max-Age', '600');
      res.setHeader('Access-Control-Expose-Headers', 'Retry-After');
    }
    if (req.method === 'OPTIONS') return allowed ? res.status(204).end() : res.status(403).end();
    next();
  };
}
