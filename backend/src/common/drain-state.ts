/**
 * Process-wide "draining" flag. A Super Admin can ask an instance to drain from the System Health page: it then answers 503 on
 * GET /api/v1/ready (so a load balancer that health-checks that URL stops sending it new requests) and refuses new realtime connections,
 * while requests already in flight finish normally. The flag lives only in memory: a restarted instance starts normal again.
 */
export const drainState: { active: boolean; since: number | null } = { active: false, since: null };

export function setDraining(on: boolean): boolean {
  if (on === drainState.active) return false;
  drainState.active = on;
  drainState.since = on ? Date.now() : null;
  return true;
}
