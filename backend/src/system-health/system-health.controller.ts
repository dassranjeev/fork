import { BadRequestException, Controller, Get, Param, Post, Query, Req, ServiceUnavailableException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { DataSource } from 'typeorm';
import { NoImpersonation, Public, UserTypes } from '../common/decorators';
import { UserType } from '../common/enums';
import { drainState } from '../common/drain-state';
import { AuditService } from '../audit/audit.service';
import { SystemHealthService } from './system-health.service';

const INSTANCE_ID = /^[A-Za-z0-9._:-]{1,100}$/;

/**
 * System Health (Super Admin ONLY, not even staff with every permission): live server health, CPU / RAM, database and the load-balancing view.
 * The page itself streams over the websocket (`system.subscribe`); these routes are the first load, a polling fallback and the actions.
 */
@Controller('admin/system')
@UserTypes(UserType.SUPER_ADMIN)
@NoImpersonation()
@ApiTags('Admin / system health')
@ApiBearerAuth()
export class SystemHealthController {
  constructor(
    private health: SystemHealthService,
    private audit: AuditService,
  ) {}

  /** Everything on the page. `?refresh=1` re-runs the cached dependency checks (TLS, integrations, migrations) now. */
  @Get('health')
  snapshot(@Req() req: any, @Query('refresh') refresh?: string) {
    return this.health.snapshot({ req, forceChecks: refresh === '1' });
  }

  /** Which instance answered: used by the page's "balance test" (many requests through the real load balancer, counted per instance). */
  @Get('whoami')
  whoami() {
    return this.health.whoami();
  }

  /** Stop sending new traffic to one instance (it answers 503 on /api/v1/ready). Refused for the last instance that accepts traffic. */
  @Post('instances/:id/drain')
  async drain(@Param('id') id: string, @Req() req: any) {
    if (!INSTANCE_ID.test(id)) throw new BadRequestException('Invalid instance id');
    const r = await this.health.setDrain(id, true);
    void this.audit.logReq(req, 'system.instance_drain', 'system_instance', undefined, undefined, { instance: id, draining: true });
    return r;
  }

  @Post('instances/:id/resume')
  async resume(@Param('id') id: string, @Req() req: any) {
    if (!INSTANCE_ID.test(id)) throw new BadRequestException('Invalid instance id');
    const r = await this.health.setDrain(id, false);
    void this.audit.logReq(req, 'system.instance_resume', 'system_instance', undefined, undefined, { instance: id, draining: false });
    return r;
  }
}

/**
 * Readiness probe for the load balancer (Caddy: `health_uri /api/v1/ready`). 200 = send me traffic; 503 = draining or the database is unreachable.
 * Deliberately independent of the System Health tables: a monitoring failure must never take the site out of rotation.
 * (GET /api/v1/health stays the plain liveness probe used by Docker.)
 */
@ApiTags('Health')
@Controller('ready')
export class ReadyController {
  private dbOkUntil = 0;

  constructor(@InjectDataSource() private ds: DataSource) {}

  @Public()
  @Get()
  async ready() {
    if (drainState.active) throw new ServiceUnavailableException({ ready: false, reason: 'draining' });
    if (Date.now() > this.dbOkUntil) {
      try {
        await Promise.race([this.ds.query('SELECT 1'), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000).unref())]);
        this.dbOkUntil = Date.now() + 2000; // cache a good answer briefly: balancers probe every few seconds
      } catch {
        throw new ServiceUnavailableException({ ready: false, reason: 'database' });
      }
    }
    return { ready: true };
  }
}
