import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { ChatService } from './chat.service';

/** Live chat background jobs: auto-assign, queue timeout / no-agent conversion, idle auto-close, stale presence cleanup. */
@Injectable()
export class ChatSchedulerService {
  private readonly logger = new Logger(ChatSchedulerService.name);
  private running = false;

  constructor(private chat: ChatService) {}

  @Interval(5000)
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const stale = await this.chat.presence.cleanupStale();
      if (stale.length) await this.chat.requeueAgentChats(stale);
      await this.chat.dispatchWaiting();
      await this.chat.sweepQueueTimeouts();
      await this.chat.sweepNoAgents();
      await this.chat.sweepAbandoned();
      await this.chat.sweepIdle();
    } catch (e: any) {
      this.logger.error(`chat tick failed: ${e.message}`);
    } finally {
      this.running = false;
    }
  }
}
