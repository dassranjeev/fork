import { BeforeApplicationShutdown, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { setDraining } from '../common/drain-state';
import { SystemMetricsService } from './system-metrics.service';

const BEAT_MS = 2000;

/**
 * Publishes this instance's metrics to the shared `system_instances` table every ~2 s. That table is how the System Health page sees
 * ALL instances behind a load balancer (and notices one that stopped), whichever instance happens to answer the page.
 * It also picks up a "drain" request from a Super Admin (see common/drain-state.ts).
 */
@Injectable()
export class SystemHeartbeatService implements OnModuleInit, OnModuleDestroy, BeforeApplicationShutdown {
  private readonly logger = new Logger('SystemHeartbeat');
  private timer: NodeJS.Timeout | null = null;
  private beating = false;
  private stopped = false;
  private inflight: Promise<void> | null = null;
  private warnedAt = 0;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(
    @InjectDataSource() private ds: DataSource,
    private metrics: SystemMetricsService,
  ) {}

  async onModuleInit() {
    await this.cleanup();
    void this.beat();
    this.timer = setInterval(() => void this.beat(), BEAT_MS);
    this.timer.unref();
    this.cleanupTimer = setInterval(() => void this.cleanup(), 3_600_000);
    this.cleanupTimer.unref();
  }

  onModuleDestroy() {
    this.stopped = true; // no new heartbeat may re-create the row after a clean stop removed it
    if (this.timer) clearInterval(this.timer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  /**
   * Clean stop: remove the row so the page shows the instance as gone immediately instead of "down".
   * beforeApplicationShutdown (not onApplicationShutdown): Nest guarantees it runs BEFORE the database connection is closed.
   */
  async beforeApplicationShutdown() {
    this.stopped = true;
    await this.inflight?.catch(() => undefined); // a heartbeat already on its way would otherwise re-insert the row
    try {
      await this.ds.query('DELETE FROM system_instances WHERE id = $1', [this.metrics.instanceId]);
    } catch {
      /* the database may already be closing */
    }
  }

  beat(): Promise<void> {
    if (this.beating || this.stopped) return Promise.resolve(); // the previous heartbeat is still in flight (slow database): do not pile up
    this.inflight = this.doBeat();
    return this.inflight;
  }

  private async doBeat() {
    this.beating = true;
    try {
      const m = this.metrics;
      const rows: { drainRequested: boolean }[] = await this.ds.query(
        `INSERT INTO system_instances (id, hostname, pid, "startedAt", "lastSeenAt", version, "nodeVersion", env, metrics, series)
         VALUES ($1, $2, $3, $4, now(), $5, $6, $7, $8::jsonb, $9::jsonb)
         ON CONFLICT (id) DO UPDATE SET "lastSeenAt" = now(), version = EXCLUDED.version, metrics = EXCLUDED.metrics, series = EXCLUDED.series
         RETURNING "drainRequested"`,
        [m.instanceId, m.hostname, process.pid, new Date(m.startedAt), m.version, m.nodeVersion, process.env.NODE_ENV ?? '', JSON.stringify(m.snapshot()), JSON.stringify(m.seriesSnapshot())],
      );
      const wanted = !!rows[0]?.drainRequested;
      if (setDraining(wanted)) this.logger.warn(wanted ? 'DRAINING: this instance now answers 503 on /ready and refuses new realtime connections' : 'drain cancelled: this instance takes traffic again');
    } catch (e: any) {
      if (Date.now() - this.warnedAt > 60_000) {
        this.warnedAt = Date.now();
        this.logger.warn(`heartbeat failed (the System Health page cannot see this instance): ${e?.message}`);
      }
    } finally {
      this.beating = false;
    }
  }

  /** rows of instances that crashed (no clean shutdown) stay visible as "down" for an hour */
  async cleanup() {
    try {
      await this.ds.query(`DELETE FROM system_instances WHERE "lastSeenAt" < now() - interval '1 hour'`);
    } catch {
      /* table may not exist yet (migration pending): the heartbeat will report it */
    }
  }
}
