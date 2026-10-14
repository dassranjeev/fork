import { Controller, Get, Global, Module, OnModuleInit, Query, Logger } from '@nestjs/common';
import { InjectDataSource, TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AuditLog } from '../database/entities';
import { AuditService } from './audit.service';
import { AdminController, Permission } from '../common/decorators';
import { Action, Module as Mod } from '../common/enums';
import { PageQueryDto } from '../common/pagination';
import { IsOptional, IsString } from 'class-validator';

class AuditQueryDto extends PageQueryDto {
  @IsOptional() @IsString() actorId?: string;
  @IsOptional() @IsString() action?: string;
  @IsOptional() @IsString() entity?: string;
  @IsOptional() @IsString() entityId?: string;
  @IsOptional() @IsString() from?: string;
  @IsOptional() @IsString() to?: string;
}

@AdminController('audit-logs')
class AuditController {
  constructor(private audit: AuditService) {}

  @Get()
  @Permission(Mod.AUDIT, Action.VIEW)
  list(@Query() q: AuditQueryDto) {
    return this.audit.search(q);
  }
}

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([AuditLog])],
  providers: [AuditService],
  controllers: [AuditController],
  exports: [AuditService],
})
export class AuditModule implements OnModuleInit {
  private readonly logger = new Logger('AuditModule');

  constructor(@InjectDataSource() private ds: DataSource) {}

  /** Make the audit table append-only at the database level (non-editable, 7-year retention). */
  async onModuleInit() {
    try {
      await this.ds.query(`
        CREATE OR REPLACE FUNCTION forky_audit_immutable() RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'audit_logs is append-only';
        END; $$ LANGUAGE plpgsql;
      `);
      await this.ds.query(`DROP TRIGGER IF EXISTS audit_logs_immutable ON audit_logs;`);
      await this.ds.query(`
        CREATE TRIGGER audit_logs_immutable BEFORE UPDATE OR DELETE ON audit_logs
        FOR EACH ROW EXECUTE FUNCTION forky_audit_immutable();
      `);
    } catch (e: any) {
      this.logger.warn(`could not install audit immutability trigger: ${e.message}`);
    }
  }
}
