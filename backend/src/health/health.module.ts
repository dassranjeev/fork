import { Controller, Get, Module } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { ApiTags } from '@nestjs/swagger';
import { DataSource } from 'typeorm';
import { Public } from '../common/decorators';

@ApiTags('Health')
@Controller('health')
class HealthController {
  constructor(@InjectDataSource() private ds: DataSource) {}

  @Public()
  @Get()
  async health() {
    let db = 'up';
    try {
      await this.ds.query('SELECT 1');
    } catch {
      db = 'down';
    }
    return { status: db === 'up' ? 'ok' : 'degraded', db, uptimeSec: Math.round(process.uptime()), time: new Date().toISOString() };
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
