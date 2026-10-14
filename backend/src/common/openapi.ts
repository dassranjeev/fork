import { DocumentBuilder, OpenAPIObject } from '@nestjs/swagger';

/**
 * The OpenAPI (Swagger) document: one definition used by the live /docs page (main.ts) and by the file export
 * (`npm run openapi:export` -> docs/openapi/openapi.json + openapi.yaml), so both always say the same.
 */
const DESCRIPTION = `Food delivery marketplace API (customers, restaurants and stores, drivers, staff).

**Base URL.** Paths already contain \`/api/v1\`. Set the server variable \`baseUrl\` to the API host (for example \`https://api.example.ca\`).

**Who calls what**
- \`/auth/*\`: sign-in, tokens and account security, for every app
- \`/admin/*\`: Admin Console (staff and Super Admin; staff only see what their role allows). \`/admin/system/*\` is Super Admin only
- \`/restaurant/*\`: Restaurant Portal and kitchen tablet
- \`/driver/*\`: driver app
- \`/customer/*\`: customer app and website
- \`/public/*\`, \`/health\`, \`/ready\`: no sign-in
- \`/orders/:id/tracking\` and \`/orders/:id/messages\`: shared by everyone involved in an order
- Realtime: Socket.IO on the same host (not described by OpenAPI): \`docs/ARCHITECTURE.md\` and the module guides list the rooms and events

**Signing in.** \`POST /auth/login\` with \`{ identifier, password, app }\` (\`app\`: \`admin\`, \`restaurant\`, \`driver\` or \`customer\`; \`identifier\` is an email or phone number).
The answer is either \`{ accessToken, refreshToken, expiresIn, user }\`, or \`{ requires2fa: true, tempToken }\` when two-factor sign-in is on
(then \`POST /auth/2fa/verify\` with \`{ tempToken, code }\`), or \`{ requires2faSetup: true, tempToken }\` the first time an account that must use 2FA signs in.
Send the access token as \`Authorization: Bearer <accessToken>\`. It is short lived: renew it with \`POST /auth/refresh\` and the refresh token.
Login is limited to about 10 attempts per minute per address.

**Errors.** Every failure has the same JSON body, \`ErrorResponse\`: \`{ statusCode, message, code?, details?, path, timestamp }\`.
Validation failures are \`400\` with \`message: "Validation failed"\` and one text per problem in \`details\`. Fields that are not part of a request are rejected (\`400\`), not ignored.
\`401\` not signed in or token expired, \`403\` signed in but not allowed, \`404\` not found, \`409\` conflict, \`429\` too many requests (see the \`x-ratelimit-*\` and \`Retry-After\` headers).

**Conventions.** Money is in Canadian dollars (numbers with 2 decimals). Timestamps are ISO 8601 UTC strings. Ids are UUIDs. Lists are paginated with the \`page\` (from 1) and \`limit\` (default 20, usually at most 100) query parameters.
Response bodies are described where the server returns a typed object; for the rest, the examples in \`docs/api/*.md\` show the shape.`;

export function buildOpenApiConfig() {
  return new DocumentBuilder()
    .setTitle('FORKSY API')
    .setDescription(DESCRIPTION)
    .setVersion('1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Access token from POST /auth/login (and /auth/2fa/verify when two-factor sign-in is on)' })
    .addServer('{baseUrl}', 'API host. The paths already include /api/v1', {
      baseUrl: { default: 'http://localhost:4000', description: 'for example https://api.example.ca or http://localhost:4000' },
    })
    .build();
}

const ERROR_SCHEMA = {
  type: 'object',
  description: 'Every error response has this shape.',
  required: ['statusCode', 'message', 'path', 'timestamp'],
  properties: {
    statusCode: { type: 'integer', example: 400 },
    message: { type: 'string', example: 'Validation failed' },
    code: { type: 'string', description: 'Machine-readable reason for some business-rule errors', example: 'PAYMENT_INTENT_REQUIRED' },
    retryAfterSeconds: { type: 'integer', description: 'On 429: how long to wait' },
    details: { type: 'array', items: { type: 'string' }, description: 'On 400 validation errors: one text per problem', example: ['password must be a string'] },
    path: { type: 'string', example: '/api/v1/auth/login' },
    timestamp: { type: 'string', format: 'date-time' },
  },
};

const METHOD_ORDER = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'];

const GROUPS: { name: string; test: (tag: string) => boolean }[] = [
  { name: 'Admin console', test: (t) => /^Admin\b/i.test(t) },
  { name: 'Restaurant portal', test: (t) => /^Restaurant\b/i.test(t) },
  { name: 'Driver app', test: (t) => /^Driver\b/i.test(t) },
  { name: 'Customer app and website', test: (t) => /^Customer\b/i.test(t) },
  { name: 'Public (no sign-in)', test: (t) => /^Public\b/i.test(t) },
];

/** Recursively sorts object keys so the exported file only changes when the API changes (arrays keep their order). */
export function sortKeysDeep<T>(v: T): T {
  if (Array.isArray(v)) return v.map(sortKeysDeep) as any;
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v as any).sort().map((k) => [k, sortKeysDeep((v as any)[k])])) as any;
  return v;
}

/**
 * Adds what the code generator cannot know: the shared error response, tag groups for readable navigation (Redoc `x-tagGroups`),
 * and a stable ordering of paths and tags.
 */
export function enrichOpenApi(doc: OpenAPIObject): OpenAPIObject {
  doc.components = doc.components ?? {};
  doc.components.schemas = { ...(doc.components.schemas ?? {}), ErrorResponse: ERROR_SCHEMA as any };

  const tagNames = new Set<string>();
  const sortedPaths: Record<string, any> = {};
  for (const p of Object.keys(doc.paths).sort()) {
    const item: Record<string, any> = doc.paths[p];
    const ordered: Record<string, any> = {};
    for (const k of Object.keys(item).sort((a, b) => (METHOD_ORDER.indexOf(a) + 1 || 99) - (METHOD_ORDER.indexOf(b) + 1 || 99))) {
      const op = item[k];
      if (op && typeof op === 'object' && op.responses) {
        for (const t of op.tags ?? []) tagNames.add(t);
        // The generator marks every @Query() parameter as required because it cannot see that the validators allow it to be missing. They almost never are
        // required (list filters, paging, coordinates ...): documenting them as required would force clients to send them. Path parameters stay required.
        for (const p of op.parameters ?? []) {
          if (p.in !== 'query') continue;
          p.required = false;
          if (p.name === 'restaurantId') p.description = 'Needed only when the signed-in account manages several locations (with a single location it is used automatically).';
        }
        // every failure looks the same: say so once per operation
        op.responses.default = op.responses.default ?? { description: 'Error (400 validation, 401 not signed in, 403 not allowed, 404 not found, 409 conflict, 429 too many requests)', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };
      }
      ordered[k] = op;
    }
    sortedPaths[p] = ordered;
  }
  doc.paths = sortedPaths;

  const groupOf = (t: string) => GROUPS.find((g) => g.test(t))?.name ?? 'Shared and other';
  const tags = [...tagNames].sort((a, b) => {
    const ga = [...GROUPS.map((g) => g.name), 'Shared and other'].indexOf(groupOf(a));
    const gb = [...GROUPS.map((g) => g.name), 'Shared and other'].indexOf(groupOf(b));
    return ga - gb || a.localeCompare(b);
  });
  doc.tags = tags.map((name) => ({ name }));
  (doc as any)['x-tagGroups'] = [...GROUPS.map((g) => g.name), 'Shared and other']
    .map((name) => ({ name, tags: tags.filter((t) => groupOf(t) === name) }))
    .filter((g) => g.tags.length);

  doc.components.schemas = Object.fromEntries(Object.entries(doc.components.schemas).sort(([a], [b]) => a.localeCompare(b)));
  return doc;
}

export interface ObservedFile {
  operations: Record<string, { as?: string; requiredQuery?: string[]; undeclaredQuery?: string[]; schema: any; example: any }>;
}

/**
 * Merges the response shapes observed by backend/scripts/openapi-observe.mjs (GET answers on demo data) into the document.
 * Returns how many operations received a response schema. Entries for routes that no longer exist are ignored.
 */
/** OpenAPI 3.0 forbids an empty `required` array (an observed `{}` or an object whose rows share no key produces one). */
export function cleanSchema<T>(v: T): T {
  if (Array.isArray(v)) return v.map(cleanSchema) as any;
  if (v && typeof v === 'object') {
    const out: Record<string, any> = {};
    for (const [k, x] of Object.entries(v as any)) {
      if (k === 'required' && Array.isArray(x) && x.length === 0) continue;
      out[k] = cleanSchema(x);
    }
    return out as any;
  }
  return v;
}

export function applyObserved(doc: OpenAPIObject, observed: ObservedFile): number {
  let n = 0;
  for (const [key, o] of Object.entries(observed.operations ?? {})) {
    const [method, p] = key.split(' ');
    const op: any = (doc.paths as any)[p]?.[method.toLowerCase()];
    if (!op) continue;
    op.responses = op.responses ?? {};
    op.responses['200'] = {
      description: 'Response shape observed on demo data (a field that was empty in every demo row may be typed loosely or be missing)',
      content: { 'application/json': { schema: cleanSchema(o.schema), example: o.example } },
    };
    for (const name of o.requiredQuery ?? []) for (const prm of op.parameters ?? []) if (prm.in === 'query' && prm.name === name) prm.required = true;
    // query parameters the route demands but the generator could not see (the handler reads them from the request instead of a decorated argument)
    for (const name of o.undeclaredQuery ?? []) {
      op.parameters = op.parameters ?? [];
      if (!op.parameters.some((prm: any) => prm.in === 'query' && prm.name === name)) {
        op.parameters.push({
          name,
          in: 'query',
          required: false,
          schema: { type: 'string' },
          ...(name === 'restaurantId' ? { description: 'Needed only when the signed-in account manages several locations (with a single location it is used automatically).' } : {}),
        });
      }
    }
    n++;
  }
  return n;
}
