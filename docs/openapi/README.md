# OpenAPI file for frontend developers

A machine-readable description of the whole HTTP API (OpenAPI 3.0): every route, its parameters, the request bodies with all fields, types, limits and
allowed values, the error format, and, for most read routes, the shape of the answer. Hand it to your frontend developers or to a code generator.

| File | What |
|---|---|
| [`openapi.json`](openapi.json) | The API description (917 operations, 285 request schemas). Use this one |
| [`openapi.yaml`](openapi.yaml) | The same content as YAML |
| [`openapi.responses.json`](openapi.responses.json) | Input of the export: response shapes observed on demo data (see below). Not for clients |

**Open links (public repository):**
`https://raw.githubusercontent.com/iwebkokri/fork/main/docs/openapi/openapi.json` and
`https://raw.githubusercontent.com/iwebkokri/fork/main/docs/openapi/openapi.yaml`.
The running API also serves it behind the docs password at `https://<api-host>/docs-json` (Swagger UI at `/docs`).

## Use it

* **Look at it:** open the file in Swagger Editor (editor.swagger.io), Redoc, Stoplight, or import it into Postman / Insomnia / Bruno (File, Import).
  Routes are grouped (`x-tagGroups`): Admin console, Restaurant portal, Driver app, Customer app and website, Public, Shared.
* **TypeScript types (recommended):**
  ```bash
  npx openapi-typescript docs/openapi/openapi.json -o src/api.d.ts
  ```
  ```ts
  import createClient from "openapi-fetch";
  import type { paths } from "./api";
  const api = createClient<paths>({ baseUrl: "https://api.forky.ca" });   // the paths already contain /api/v1
  const { data, error } = await api.POST("/api/v1/auth/login", { body: { identifier: "me@example.ca", password: "...", app: "customer" } });
  ```
* **Full clients and hooks:** `orval`, `openapi-generator`, `Kiota`, `hey-api/openapi-ts` all read this file.
* **Which host:** the file lists two servers: `https://api.forky.ca` (production, the default) and `http://localhost:4000` (local development). The API is served at
  **api.forky.ca**; the website `app.forky.ca` is only the website and does not answer API calls. To list other hosts when you export, set
  `OPENAPI_SERVERS="https://api.example.ca|Production,http://localhost:4000|Local"`. The running server's own `/docs` page always puts itself first (from `PUBLIC_URL`),
  so "Try it out" there calls the server you are looking at.
* **Authentication:** `POST /api/v1/auth/login` returns tokens (or `requires2fa` / `requires2faSetup` with a `tempToken`: then `POST /auth/2fa/verify`).
  Send `Authorization: Bearer <accessToken>`; renew with `POST /auth/refresh`. The same text is at the top of the file (`info.description`).

## What is in it, and what is not

* **Request bodies** (all 329): every field with its type, whether it is required, length / range limits, allowed values (enums) and the validators' rules.
  Fields that are not in a body are rejected by the API, not ignored, so a generated client must not send extras.
* **Parameters:** path parameters (required) and query parameters. Query parameters are documented as **optional** unless the API was seen demanding one
  (for example `restaurantId` is needed only for owners with several locations; the date of a slots request is required).
* **Errors:** every route lists the shared `ErrorResponse` (`{ statusCode, message, code?, details?, path, timestamp }`).
* **Responses (partly):** the server code does not declare its return types, so response shapes were **observed**: about 290 of the 339 read (GET) routes have a
  response schema and a short example taken from the seeded demo data. Read them as "what the API returns for demo data": a field that was empty in every demo
  row can be missing or typed loosely (`nullable` is set where a null was seen), and optional fields can be absent. Routes that need a record that does not exist in the
  demo data, external services (address search needs Mapbox) or special accounts are not covered.
* **No response bodies for writes:** `POST`, `PUT`, `PATCH`, `DELETE` document the request but not the success body (calling them would change data). They usually return the
  created or updated object; the written references in [`docs/api/`](../api) describe many of them.
* **Not in OpenAPI:** the realtime channel (Socket.IO: rooms and events, see `docs/ARCHITECTURE.md` and the module guides), file upload details, and the Stripe / Certn
  webhooks (listed as routes, but called by those services).
* `/api/v1/admin/system/*` (System Health, Super Admin only) is listed with its parameters but has no observed response because its answers contain machine names; see
  [`docs/system-health.md`](../system-health.md).

## Keeping it current

The file is generated from the code, so it never needs hand-editing:

```bash
cd backend
npm run openapi:export        # builds with the @nestjs/swagger plugin (reads the DTOs), boots the app against the database, writes openapi.json / openapi.yaml
```

To refresh the observed responses after the API changed, start the API with the demo data (`npm run seed`), then:

```bash
ADMIN_PASSWORD=... DEMO_PASSWORD=... npm run openapi:observe     # calls only GET routes; writes openapi.responses.json
npm run openapi:export                                            # merges them in
```

CI runs the export and fails when `docs/openapi` is out of date, so a change to a route or a request DTO has to come with the regenerated file.
The output is sorted and deterministic: it only changes when the API does. The file validates with `@apidevtools/swagger-parser`, and `openapi-typescript` generates
types from it.

How it is built (`backend/src/common/openapi.ts`, `backend/src/tools/export-openapi.ts`, `backend/scripts/openapi-observe.mjs`): the Nest Swagger compiler plugin
(`nest-cli.json`) turns the class-validator DTOs into schemas, the exporter adds the shared error response, tag groups and ordering and marks query parameters optional
(the generator cannot see that they are), and the observer adds the response shapes.
