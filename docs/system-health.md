# System Health (Super Admin)

A live page that shows how healthy the servers are and how traffic is spread over the API instances.
Open it in the Admin Console under **System > System Health** (`/system-health`).

**Who can see it:** Super Admin accounts only. Staff accounts, even with every permission, do not see the menu entry, get "not allowed"
on the URL, and the API refuses them on every route and on the websocket. Customers, drivers and restaurants have no access at all.

## What the page shows

| Section | What it tells you |
|---|---|
| Status banner | One verdict (healthy / warnings / critical) and the list of current problems in plain words |
| Tiles | API instances up, requests per second, response time (p95), server-error rate (5xx), live connections, database connections |
| Server resources | CPU, memory, swap, disk and load average of each server (gauges coloured green / amber / red), CPU steal and disk wait, uploads folder space, container limits |
| Charts (last 5 minutes) | Requests per second per instance, response time p95, server CPU and memory, API memory, event-loop delay, 5xx rate |
| API instances | One row per running API process: status, requests/s, share of traffic, p95, 5xx, CPU, memory, event-loop delay, sockets, database pool, **Drain / Resume** |
| Load balancing | Verdict on how evenly traffic is spread, a **live balance test**, and the scale-out readiness list |
| Database | Connections of the maximum, round trip, size, longest running query, lock waits, cache hit ratio, idle-in-transaction |
| Dependencies and configuration | Database, clock drift, migrations, uploads folder, Stripe, Mapbox, email, SMS, TLS certificate expiry, proxy headers |
| Busiest routes | Last 5 minutes, all instances: most requested, slowest, most errors (route patterns only) |

The page updates itself every 2 seconds over a websocket. If the socket is blocked it says "Polling every 5 s" and keeps working. **Pause** freezes
the screen; **Refresh** reloads now; **Re-run checks** re-runs the cached dependency checks (TLS, integrations, migrations) immediately.

## Colours and limits

Amber and red come from numbers you can change in **Platform Settings, group `system`** (they apply within about a minute). Defaults suit a small single-server install:

| Measure | Amber at | Red at |
|---|---|---|
| Server CPU use | 75 % | 90 % |
| Memory in use (available memory, not "free": cache does not count) | 85 % | 93 % |
| Swap in use | 25 % | 60 % |
| Disk full (system disk and uploads folder) | 80 % | 92 % |
| Load average per CPU core (5 min) | 1.0 | 2.0 |
| Event-loop delay p99 | 100 ms | 500 ms |
| Response time p95 | 800 ms | 2500 ms |
| Server errors (5xx) | 1 % | 5 % |
| Database pool in use / connections of max | 80 % | 95 % |
| Load balancing skew (points off an even split) | 10 | 25 |
| TLS certificate days left | 14 | 5 |

Rates (5xx %, p95, balance) are only judged with at least 20 requests in the last minute; a quiet system is not "unhealthy". Other amber conditions:
CPU steal of 10 % or more (a noisy neighbour on the VPS), disk wait of 30 % or more, queries waiting for a database connection, a query running for 30 s or more,
more than 5 lock requests waiting, more than 5 connections idle inside an open transaction, clock drift between the API and the database over 2 s.

## How it works

* Every API process measures itself in memory: request count, latency (histogram, so merged percentiles stay accurate), errors, event-loop delay, CPU and
  memory of the process, database pool and websocket counts. It also reads the server it runs on: CPU (including steal and disk wait), available memory, swap,
  load average (from `/proc` on Linux), disk space (`statfs`) and, in Docker, the cgroup limits.
* Every ~2 seconds each process writes **one row** to the table `system_instances` (UNLOGGED: no write-ahead log, so the churn costs nothing in WAL; about 2 KB per
  row). The page builds its view from all rows, so it shows **every instance whichever one answers it**, and notices one that stopped.
* An instance is **up** when its last heartbeat is under 8 s old, **slow to report** between 8 and 30 s (usually a blocked event loop), **down** after 30 s.
  A clean stop removes the row immediately; a crash leaves it visible as "down" for an hour. A "down" row on a host that has a newer instance is shown as
  "stopped (restarted)" and raises a warning for 15 minutes.
* Request statistics use the matched **route pattern** (`GET /api/v1/admin/orders/:id`), never the raw URL: no ids, query strings or personal data, and
  unmatched URLs (scanners) share one key. Health probes (`/health`, `/ready`), this page's own routes and websocket polling are not counted as traffic.
* The live stream (`system.health`) is only produced while a Super Admin has the page open; the socket message `system.subscribe` is refused for every other
  account type. Nothing here contains secrets: integrations show configured / not configured and the mode, never a key.

## Reviewing load balancing

* **Verdict.** The traffic share of each instance over the last minute is compared with an even split among the instances that accept traffic. Within 10 points
  it is *balanced*; 10 to 25 *skewed* (amber); more is *unbalanced* (red) and names the overloaded instance. With one instance the page says plainly that
  there is no load balancing in place (that is information, not an error).
* **Live balance test.** The button sends 60 requests through the real route (proxy included) and counts which instance answered each. Note: if your proxy
  uses sticky sessions (`ip_hash`, a cookie), one browser always reaches the same instance, so the test cannot show a spread.
* **Drain / Resume.** Drain asks an instance to stop taking new traffic: it answers **503 on `GET /api/v1/ready`** and refuses new realtime connections, while
  requests already running finish. It only changes routing if your proxy health-checks that URL (Caddy: `health_uri /api/v1/ready`, see below). Use it before
  restarting an instance. The last instance that accepts traffic cannot be drained (the API refuses: it would take the site offline), a drained instance is
  not expected to carry traffic in the balance verdict, and the flag lives in memory, so a restarted instance takes traffic again. Drain and resume are recorded
  in the audit log (`system.instance_drain`, `system.instance_resume`).
* `/api/v1/ready` is the readiness probe (200 or 503) and `/api/v1/health` stays the plain liveness probe Docker uses. Readiness only depends on draining and
  database reachability, never on the System Health tables, so a monitoring problem cannot take the site out of rotation.
* **Proxy headers.** The "Proxy headers" check compares what your own request looked like with `TRUST_PROXY`. A proxy in front but `TRUST_PROXY` unset makes every
  client look like the proxy (rate limits and audit-log IPs break); `TRUST_PROXY` set while requests arrive directly lets clients spoof their address.

### Scale-out readiness: one instance only, today

The page lists what stops a second API instance from working correctly. They are **not problems with one instance**; with two or more running they become red:

1. **Realtime events reach every instance**: Socket.IO uses its in-memory adapter, so an event emitted on one instance only reaches the clients connected to it
   (driver offers, order updates, chat). Needs a shared adapter such as Redis.
2. **Rate limits are shared**: throttling counters are per process (with N instances every limit is N times higher).
3. **Scheduled jobs run on one instance only**: cron jobs have no leader election and would run on every instance.
4. **Dispatch offers survive a restart / failover**: offer timers are in-process.
5. **Uploaded files are on shared storage**: uploads and proof-of-delivery photos are on a local disk volume.

So the system is built and supported as **one API instance** (vertical scaling: a bigger server). The page is there to show you when that single server is
getting tight, and to let you see, test and manage a balanced setup once these five points are solved.

## Running more than one instance (after the five points are solved)

```bash
GIT_SHA=$(git rev-parse --short HEAD) docker compose --env-file deploy/.env build      # the commit shows per instance on the page
docker compose --env-file deploy/.env up -d --scale api=2
```

Caddy must spread requests over all replicas and take a draining or dead one out of rotation. `reverse_proxy api:4000` only resolves one address, so use
dynamic upstreams with a health check (validated against Caddy 2.11):

```caddy
{$API_DOMAIN} {
  encode gzip
  reverse_proxy {
    dynamic a {
      name api
      port 4000
      refresh 5s
    }
    lb_policy least_conn         # or: cookie  (sticky sessions; Socket.IO long-polling needs them unless clients use websocket only)
    health_uri /api/v1/ready
    health_interval 5s
    health_timeout 2s
    health_status 2xx
  }
}
```

Set `TRUST_PROXY` to the number of proxies in front (the bundled Caddy is one hop).

## Try it on one machine

`backend/test/lb-sim.mjs` is a tiny local balancer (round-robin, random, `weighted:90,10`, sticky; health-checks `/api/v1/ready` like Caddy). Run two API
instances against the same database on two ports and put it in front:

```bash
# terminal 1 and 2 (same DB, different ports; DB_SYNC=false once the database is migrated)
PORT=4101 npx ts-node --transpile-only -r tsconfig-paths/register src/main.ts
PORT=4102 npx ts-node --transpile-only -r tsconfig-paths/register src/main.ts
# terminal 3
node test/lb-sim.mjs --listen 4100 --to http://localhost:4101,http://localhost:4102
# policy can be changed live to see a skewed verdict:  curl -X POST "localhost:4100/__lb/policy?value=weighted:90,10"
```

Point the admin console at `http://localhost:4100` (or call the API through it), open the page and press **Test the balancer**.

## API reference (Super Admin token)

| Route | Purpose |
|---|---|
| `GET /api/v1/admin/system/health` | The whole snapshot (`?refresh=1` re-runs the cached checks) |
| `GET /api/v1/admin/system/whoami` | Which instance answered (used by the balance test) |
| `POST /api/v1/admin/system/instances/:id/drain` | Stop new traffic to one instance (refused for the last accepting instance and for a down one) |
| `POST /api/v1/admin/system/instances/:id/resume` | Accept traffic again |
| `GET /api/v1/ready` | Public readiness probe: 200 `{ready:true}` or 503 (`draining` / `database`) |
| socket `system.subscribe` / `system.unsubscribe` | Join / leave the live room; ack `{ok:false,error:"forbidden"}` for anyone but a Super Admin |
| socket event `system.health` | The snapshot, about every 2 s, while at least one Super Admin watches |

## Limits

* It measures the **API process and the server it runs on**. CPU and memory of the other containers (database, proxy) are only visible as part of the server
  totals; per-container numbers would need access to the Docker socket, which is deliberately not granted to the API.
* The proxy's own statistics are not read. Traffic shares are counted by the API instances.
* History is the last 5 minutes (a live view, not a monitoring archive); counters restart with the process. For long-term history use a metrics stack
  (Prometheus and Grafana) next to it.
* Load average and swap are not available on Windows development machines; the page then hides them.

## Tests

```bash
cd backend
npx ts-node --transpile-only test/system-health.test.ts       # unit: percentiles, CPU / memory parsing, balance verdicts (39 checks)
ADMIN_PASSWORD=... DEMO_PASSWORD=... node test/system-health-e2e.mjs   # running API: access control incl. websocket, data, drain safety, settings (42 checks)
```

The two-instance behaviour (aggregation, even and skewed traffic, drain and resume through a health-checked balancer, crash detection) was verified with two
real API processes behind `lb-sim.mjs` on a scratch database.
