import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiTags } from '@nestjs/swagger';
import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { AdminController, CurrentUser, CustomerController, Permission, Public, PublicController, RestaurantController, RestaurantRoles } from '../common/decorators';
import { Action, Module as Mod, RestaurantRole } from '../common/enums';
import { AuthUser } from '../common/auth.types';
import { resolveRestaurantId } from '../restaurants/restaurants.util';
import { AssistantConfigService } from './assistant-config.service';
import { AdminUpdateAssistantDto, AssistantChatDto, AssistantFeedbackDto, AssistantConfigQuery, AssistantHandoffDto, ImportHandoffDto, UpdateAssistantDto } from './assistant.dto';
import { AssistantService } from './assistant.service';

const MANAGERS = [RestaurantRole.OWNER, RestaurantRole.LOCATION_MANAGER];

// ------------------------------------------------------------------ public (guests; a customer Bearer token marks the visitor as logged in)
@PublicController('assistant')
export class PublicAssistantController {
  constructor(private svc: AssistantService) {}

  @Get('config')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Header('Cache-Control', 'no-store')
  config(@Query() q: AssistantConfigQuery, @Req() req: any) {
    return this.svc.publicConfig(q, req);
  }

  @Post('chat')
  @Throttle({ default: { limit: 30, ttl: 60_000 } }) // per IP; 12 / minute per session is enforced in the service
  chat(@Body() dto: AssistantChatDto, @Req() req: any) {
    return this.svc.chat(dto, req);
  }

  @Post('feedback')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  feedback(@Body() dto: AssistantFeedbackDto) {
    return this.svc.feedback(dto);
  }

  @Post('handoff')
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  handoff(@Body() dto: AssistantHandoffDto, @Req() req: any) {
    return this.svc.handoff(dto, req);
  }
}

// ------------------------------------------------------------------ the embeddable widget script (NOT under /api/v1)
let widgetCache: { body: string; at: number; mtime: number } | null = null;

function readWidget(): string {
  const candidates = [join(process.cwd(), 'assets', 'assistant-widget.js'), join(__dirname, '..', '..', 'assets', 'assistant-widget.js'), join(__dirname, '..', '..', '..', 'assets', 'assistant-widget.js')];
  const file = candidates.find((f) => existsSync(f));
  if (!file) return '/* FORKSY assistant widget is not installed on this server */';
  const mtime = statSync(file).mtimeMs;
  // cached in memory; outside production the file is re-checked every 5 s so edits show up without a restart
  if (widgetCache && (process.env.NODE_ENV === 'production' || (Date.now() - widgetCache.at < 5000 && widgetCache.mtime === mtime))) return widgetCache.body;
  widgetCache = { body: readFileSync(file, 'utf8'), at: Date.now(), mtime };
  return widgetCache.body;
}

@Controller('assistant')
@Public()
@ApiTags('Public / assistant widget')
export class AssistantWidgetController {
  @Get('widget.js')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  widget(@Res() res: any) {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Access-Control-Allow-Origin', '*'); // a public script: any website may load it
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.send(readWidget());
  }
}

let iconCache: Buffer | null = null;
function readIcon(): Buffer | null {
  if (iconCache) return iconCache;
  const candidates = [join(process.cwd(), 'assets', 'forksy-icon-96.png'), join(__dirname, '..', '..', 'assets', 'forksy-icon-96.png'), join(__dirname, '..', '..', '..', 'assets', 'forksy-icon-96.png')];
  const file = candidates.find((f) => existsSync(f));
  iconCache = file ? readFileSync(file) : null;
  return iconCache;
}

/** the default avatar of every assistant that has neither an admin logo nor a restaurant logo: the FORKSY icon */
@Controller('assistant')
@Public()
@ApiTags('Public / assistant widget')
export class AssistantIconController {
  @Get('forksy-icon.png')
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  icon(@Res() res: any) {
    const img = readIcon();
    if (!img) return res.status(404).end();
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.send(img);
  }
}

// ------------------------------------------------------------------ customer
@CustomerController('assistant')
export class CustomerAssistantController {
  constructor(private svc: AssistantService) {}

  @Post('import-handoff')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  importHandoff(@CurrentUser() user: AuthUser, @Body() dto: ImportHandoffDto) {
    return this.svc.importHandoff(user, dto.token);
  }
}

// ------------------------------------------------------------------ restaurant portal
@RestaurantController('assistant')
export class RestaurantAssistantController {
  constructor(private cfg: AssistantConfigService) {}

  @Get()
  view(@CurrentUser() user: AuthUser, @Query('restaurantId') restaurantId?: string) {
    return this.cfg.view(resolveRestaurantId(user, restaurantId));
  }

  @Patch()
  @RestaurantRoles(...MANAGERS)
  update(@CurrentUser() user: AuthUser, @Body() dto: UpdateAssistantDto, @Req() req: any, @Query('restaurantId') restaurantId?: string) {
    return this.cfg.update(resolveRestaurantId(user, restaurantId), dto, user, req);
  }

  @Post('rotate-key')
  @RestaurantRoles(...MANAGERS)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  rotate(@CurrentUser() user: AuthUser, @Req() req: any, @Query('restaurantId') restaurantId?: string) {
    return this.cfg.rotateKey(resolveRestaurantId(user, restaurantId), req);
  }
}

// ------------------------------------------------------------------ admin console
@AdminController('restaurants')
export class AdminAssistantController {
  constructor(private cfg: AssistantConfigService) {}

  @Get(':id/assistant')
  @Permission(Mod.RESTAURANTS, Action.VIEW)
  view(@Param('id', ParseUUIDPipe) id: string) {
    return this.cfg.view(id);
  }

  @Patch(':id/assistant')
  @Permission(Mod.RESTAURANTS, Action.EDIT)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AdminUpdateAssistantDto, @CurrentUser() user: AuthUser, @Req() req: any) {
    return this.cfg.adminUpdate(id, dto, user, req);
  }
}
