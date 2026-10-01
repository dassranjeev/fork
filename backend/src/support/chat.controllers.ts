import { Body, Get, Param, Post, Put, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AdminController, CurrentUser, CustomerController, DriverController, Permission } from '../common/decorators';
import { Action, Module as Mod } from '../common/enums';
import { AuthUser } from '../common/auth.types';
import { ChatRequester, ChatService } from './chat.service';
import { ChatAgentService } from './chat-agent.service';
import { ChatEndDto, ChatMessageDto, ChatMessagesQueryDto, ChatPresenceDto, ChatQueueQueryDto, ChatRateDto, ChatTransferDto, ChatTypingDto, StartChatDto } from './chat.dto';

/** Shared customer/driver chat API (see docs/api/live-chat.md). Subclasses only decide who the requester is. */
abstract class RequesterChatController {
  constructor(protected chat: ChatService) {}
  protected abstract requester(u: AuthUser): ChatRequester;

  @Get('availability')
  availability(@CurrentUser() u: AuthUser) {
    return this.chat.availability(this.requester(u).type);
  }

  @Get('active')
  active(@CurrentUser() u: AuthUser) {
    return this.chat.active(this.requester(u));
  }

  @Get('sessions')
  sessions(@CurrentUser() u: AuthUser) {
    return this.chat.mine(this.requester(u));
  }

  @Post('start')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  start(@Body() dto: StartChatDto, @CurrentUser() u: AuthUser) {
    return this.chat.start(this.requester(u), dto);
  }

  @Get(':id/messages')
  async messages(@Param('id') id: string, @Query() q: ChatMessagesQueryDto, @CurrentUser() u: AuthUser) {
    const r = this.requester(u);
    const s = await this.chat.own(r, id);
    return { session: await this.chat.requesterView(s), messages: await this.chat.messagesFor(s, { forAgent: false, after: q.after }) };
  }

  @Post(':id/messages')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  send(@Param('id') id: string, @Body() dto: ChatMessageDto, @CurrentUser() u: AuthUser) {
    return this.chat.sendFromRequester(this.requester(u), id, dto);
  }

  @Post(':id/read')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  read(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.chat.readFromRequester(this.requester(u), id);
  }

  @Post(':id/typing')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  typing(@Param('id') id: string, @Body() dto: ChatTypingDto, @CurrentUser() u: AuthUser) {
    return this.chat.typingFromRequester(this.requester(u), id, dto.typing !== false);
  }

  @Post(':id/end')
  end(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.chat.endFromRequester(this.requester(u), id);
  }

  @Post(':id/rate')
  rate(@Param('id') id: string, @Body() dto: ChatRateDto, @CurrentUser() u: AuthUser) {
    return this.chat.rate(this.requester(u), id, dto.rating, dto.feedback);
  }
}

@CustomerController('support/chat')
export class CustomerChatController extends RequesterChatController {
  constructor(chat: ChatService) {
    super(chat);
  }

  protected requester(u: AuthUser): ChatRequester {
    return { type: 'CUSTOMER', userId: u.id, name: u.name };
  }
}

@DriverController('support/chat')
export class DriverChatController extends RequesterChatController {
  constructor(chat: ChatService) {
    super(chat);
  }

  protected requester(u: AuthUser): ChatRequester {
    return { type: 'DRIVER', userId: u.id, driverId: u.driverId, name: u.name };
  }
}

/** Agent console API. */
@AdminController('support/chat')
export class AdminChatController {
  constructor(private agent: ChatAgentService) {}

  @Get('queue')
  @Permission(Mod.SUPPORT, Action.VIEW)
  queue(@Query() q: ChatQueueQueryDto, @CurrentUser() u: AuthUser) {
    return this.agent.queue(u, q.status);
  }

  @Get('agents')
  @Permission(Mod.SUPPORT, Action.VIEW)
  agents() {
    return this.agent.agents();
  }

  @Get('stats')
  @Permission(Mod.SUPPORT, Action.VIEW)
  stats(@CurrentUser() u: AuthUser) {
    return this.agent.stats(u);
  }

  @Get('presence')
  @Permission(Mod.SUPPORT, Action.VIEW)
  presence(@CurrentUser() u: AuthUser) {
    return this.agent.heartbeat(u);
  }

  @Put('presence')
  @Permission(Mod.SUPPORT, Action.EDIT)
  setPresence(@Body() dto: ChatPresenceDto, @CurrentUser() u: AuthUser) {
    return this.agent.setPresence(u, dto.status, dto.maxConcurrentChats);
  }

  @Post('presence/heartbeat')
  @Permission(Mod.SUPPORT, Action.EDIT)
  heartbeat(@CurrentUser() u: AuthUser) {
    return this.agent.heartbeat(u);
  }

  @Get(':id')
  @Permission(Mod.SUPPORT, Action.VIEW)
  detail(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.agent.detail(u, id);
  }

  @Post(':id/accept')
  @Permission(Mod.SUPPORT, Action.EDIT)
  accept(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.agent.accept(u, id);
  }

  @Post(':id/messages')
  @Permission(Mod.SUPPORT, Action.EDIT)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  reply(@Param('id') id: string, @Body() dto: ChatMessageDto, @CurrentUser() u: AuthUser) {
    return this.agent.reply(u, id, dto);
  }

  @Post(':id/notes')
  @Permission(Mod.SUPPORT, Action.EDIT)
  note(@Param('id') id: string, @Body() dto: ChatMessageDto, @CurrentUser() u: AuthUser) {
    return this.agent.note(u, id, dto.body ?? '');
  }

  @Post(':id/typing')
  @Permission(Mod.SUPPORT, Action.EDIT)
  @Throttle({ default: { limit: 240, ttl: 60_000 } })
  typing(@Param('id') id: string, @Body() dto: ChatTypingDto, @CurrentUser() u: AuthUser) {
    return this.agent.typing(u, id, dto.typing !== false);
  }

  @Post(':id/read')
  @Permission(Mod.SUPPORT, Action.EDIT)
  read(@Param('id') id: string) {
    return this.agent.read(id);
  }

  @Post(':id/transfer')
  @Permission(Mod.SUPPORT, Action.EDIT)
  transfer(@Param('id') id: string, @Body() dto: ChatTransferDto, @CurrentUser() u: AuthUser) {
    return this.agent.transfer(u, id, dto);
  }

  @Post(':id/end')
  @Permission(Mod.SUPPORT, Action.EDIT)
  end(@Param('id') id: string, @Body() dto: ChatEndDto, @CurrentUser() u: AuthUser) {
    return this.agent.end(u, id, dto);
  }

  @Post(':id/convert')
  @Permission(Mod.SUPPORT, Action.EDIT)
  convert(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.agent.convert(u, id);
  }
}
