import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SystemInstance } from '../database/entities';
import { ReadyController, SystemHealthController } from './system-health.controller';
import { SystemHealthService } from './system-health.service';
import { SystemHeartbeatService } from './system-heartbeat.service';
import { SystemMetricsService } from './system-metrics.service';
import { SystemStreamService } from './system-stream.service';

/**
 * System Health: live server health for Super Admins (CPU, RAM, disk, database, request latency / errors) and a load-balancing view
 * across every API instance. See docs/system-health.md.
 */
@Module({
  imports: [TypeOrmModule.forFeature([SystemInstance])],
  controllers: [SystemHealthController, ReadyController],
  providers: [SystemMetricsService, SystemHeartbeatService, SystemHealthService, SystemStreamService],
  exports: [SystemMetricsService],
})
export class SystemHealthModule {}
