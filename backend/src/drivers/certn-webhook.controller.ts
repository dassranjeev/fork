import { Body, Controller, Logger, Post } from '@nestjs/common';
import { Public } from '../common/decorators';
import { CertnAdapter } from './adapters/certn.adapter';
import { DriversAdminService } from './drivers-admin.service';

/** Certn calls this when a background check result is ready (SOP-02 step 2). No auth - Certn signs/IPs the call. */
@Controller('public/webhooks/certn')
@Public()
export class CertnWebhookController {
  private readonly logger = new Logger('CertnWebhook');

  constructor(
    private certn: CertnAdapter,
    private drivers: DriversAdminService,
  ) {}

  @Post()
  async handle(@Body() body: any) {
    const result = this.certn.parseWebhook(body);
    if (!result) {
      this.logger.warn('Unrecognised Certn webhook payload');
      return { ok: false };
    }
    const applied = await this.drivers.applyBackgroundResult(result);
    return { ok: applied };
  }
}
