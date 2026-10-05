import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  AgentPresence,
  CannedReply,
  ChatSession,
  CustomerProfile,
  DeviceToken,
  DriverLocationLog,
  DriverProfile,
  Order,
  OrderEvent,
  OrderItem,
  Refund,
  Restaurant,
  RestaurantMember,
  ReviewCase,
  Ticket,
  TicketMessage,
  User,
  WalletTransaction,
} from '../database/entities';
import { TicketsService } from './tickets.service';
import { OrderContextService } from './order-context.service';
import { RefundGateway } from './refund-gateway.service';
import { SelfServeService } from './self-serve.service';
import { DeliveryDisputesService } from './delivery-disputes.service';
import { ReviewCasesService } from './review-cases.service';
import { SupportSchedulerService } from './support-scheduler.service';
import { AdminSupportController } from './admin-support.controller';
import { CustomerSupportController } from './customer-support.controller';
import { RestaurantSupportController } from './restaurant-support.controller';
import { DriverSupportController } from './driver-support.controller';
import { ChatService } from './chat.service';
import { ChatAgentService } from './chat-agent.service';
import { ChatPresenceService } from './chat-presence.service';
import { ChatSchedulerService } from './chat-scheduler.service';
import { AdminChatController, CustomerChatController, DriverChatController } from './chat.controllers';

/**
 * Support desk (SOP-06 tickets/refunds/self-serve rules, SOP-08 review cases). Not @Global - other modules that
 * need `TicketsService` / `OrderContextService` / `ReviewCasesService` import `SupportModule` (see ARCHITECTURE.md
 * §3 cross-module rules); `OrdersModule`, `CoreModule`, `SettingsService`, `NotificationsService`, `RealtimeService`
 * and `AuditService` are all @Global so they do not need to be imported here.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      AgentPresence,
      ChatSession,
      Ticket,
      TicketMessage,
      ReviewCase,
      CannedReply,
      Order,
      OrderItem,
      OrderEvent,
      Refund,
      User,
      CustomerProfile,
      DriverProfile,
      DriverLocationLog,
      DeviceToken,
      WalletTransaction,
      Restaurant,
      RestaurantMember,
    ]),
  ],
  providers: [TicketsService, OrderContextService, RefundGateway, SelfServeService, DeliveryDisputesService, ReviewCasesService, SupportSchedulerService, ChatService, ChatAgentService, ChatPresenceService, ChatSchedulerService],
  controllers: [AdminSupportController, CustomerSupportController, RestaurantSupportController, DriverSupportController, CustomerChatController, DriverChatController, AdminChatController],
  exports: [ChatService, TicketsService, OrderContextService, RefundGateway, ReviewCasesService, DeliveryDisputesService],
})
export class SupportModule {}
