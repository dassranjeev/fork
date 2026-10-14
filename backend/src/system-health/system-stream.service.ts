import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { RealtimeService } from '../realtime/realtime.module';
import { SystemHealthService } from './system-health.service';

export const SYSTEM_ROOM = 'admin:system';
const EMIT_MS = 2000;

/**
 * Pushes the health snapshot to the Super Admins who have the page open (room `admin:system`, joined with the socket message
 * `system.subscribe`, which only a Super Admin socket may send). With nobody watching it does nothing, so it costs no queries.
 * Each instance streams to its OWN sockets but builds the snapshot from the shared heartbeat table, so every viewer sees every instance.
 */
@Injectable()
export class SystemStreamService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('SystemStream');
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(
    private health: SystemHealthService,
    @Optional() private rt?: RealtimeService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.emit(), EMIT_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  watchers(): number {
    const rooms = (this.rt?.server as any)?.sockets?.adapter?.rooms as Map<string, Set<string>> | undefined;
    return rooms?.get(SYSTEM_ROOM)?.size ?? 0;
  }

  private async emit() {
    if (this.busy || !this.rt || !this.watchers()) return;
    this.busy = true;
    try {
      this.rt.emitToRoom(SYSTEM_ROOM, 'system.health', await this.health.snapshot());
    } catch (e: any) {
      this.logger.debug(`stream tick failed: ${e?.message}`);
    } finally {
      this.busy = false;
    }
  }
}
