import { BadRequestException, Body, Delete, ForbiddenException, Get, Header, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AdminController, CurrentUser, Permission, RestaurantController } from '../../common/decorators';
import { AuthUser } from '../../common/auth.types';
import { Action, Module as Mod, RestaurantRole, UserType } from '../../common/enums';
import { hasPermission } from '../../common/guards';
import { resolveRestaurantId } from '../../restaurants/restaurants.util';
import { TActor, TScope, TrainingService } from './training.service';

const MANAGERS = [RestaurantRole.OWNER, RestaurantRole.LOCATION_MANAGER];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const int = (v: unknown, d?: number) => {
  const n = Number(v);
  return Number.isFinite(n) && v !== '' && v !== undefined ? Math.floor(n) : d;
};
type Body_ = Record<string, any>;

/**
 * The training API of one bot. The same handlers serve three places (docs/api/assistant-training.md):
 *   /restaurant/assistant/training/*                       the restaurant's own bot (OWNER + LOCATION_MANAGER edit, other roles read)
 *   /admin/assistant/training/restaurants/:rid/*           FORKSY staff for any restaurant (restaurants:view / restaurants:edit)
 *   /admin/assistant/training/central/*                    the FORKSY website bot (settings:view / settings:edit)
 * Bodies are validated by the service (guardrails + limits), which answers 400 with per-field messages in `details`.
 */
abstract class TrainingBase {
  constructor(protected svc: TrainingService) {}

  protected abstract resolve(req: any, user: AuthUser, write: boolean): Promise<TScope>;

  protected actor(user: AuthUser, req: any): TActor {
    return { id: user.id, name: user.name || user.email || 'user', type: user.type === UserType.RESTAURANT ? 'restaurant' : 'staff', req };
  }

  private staffOnly(user: AuthUser) {
    if (user.type === UserType.RESTAURANT) throw new ForbiddenException('Only FORKSY staff can do this');
  }

  // ---- overview
  @Get('overview')
  async overview(@CurrentUser() u: AuthUser, @Req() req: any) {
    return this.svc.overview(await this.resolve(req, u, false));
  }

  // ---- knowledge entries
  @Get('entries')
  async entries(@CurrentUser() u: AuthUser, @Req() req: any, @Query() q: Body_) {
    return this.svc.listEntries(await this.resolve(req, u, false), { search: q.search, status: q.status, page: int(q.page), limit: int(q.limit) });
  }

  @Post('entries')
  async createEntry(@CurrentUser() u: AuthUser, @Req() req: any, @Body() b: Body_) {
    return this.svc.createEntry(await this.resolve(req, u, true), this.actor(u, req), b);
  }

  @Post('entries/check')
  async check(@CurrentUser() u: AuthUser, @Req() req: any, @Body() b: Body_) {
    await this.resolve(req, u, false);
    return this.svc.checkEntryDraft(b);
  }

  @Post('entries/bulk')
  async bulk(@CurrentUser() u: AuthUser, @Req() req: any, @Body() b: Body_) {
    if (!Array.isArray(b.ids) || b.ids.length > 500 || b.ids.some((i: unknown) => typeof i !== 'string')) throw new BadRequestException('ids must be a list of answer ids');
    return this.svc.bulk(await this.resolve(req, u, true), this.actor(u, req), String(b.action), b.ids);
  }

  @Get('entries/:eid')
  async entry(@CurrentUser() u: AuthUser, @Req() req: any, @Param('eid') eid: string) {
    return this.svc.getEntry(await this.resolve(req, u, false), eid);
  }

  @Patch('entries/:eid')
  async updateEntry(@CurrentUser() u: AuthUser, @Req() req: any, @Param('eid') eid: string, @Body() b: Body_) {
    return this.svc.updateEntry(await this.resolve(req, u, true), this.actor(u, req), eid, b);
  }

  @Delete('entries/:eid')
  async deleteEntry(@CurrentUser() u: AuthUser, @Req() req: any, @Param('eid') eid: string) {
    return this.svc.deleteEntry(await this.resolve(req, u, true), this.actor(u, req), eid);
  }

  // ---- nicknames + synonyms
  @Get('aliases')
  async aliases(@CurrentUser() u: AuthUser, @Req() req: any) {
    return this.svc.aliasesAndSynonyms(await this.resolve(req, u, false));
  }

  @Get('menu-options')
  async menuOptions(@CurrentUser() u: AuthUser, @Req() req: any) {
    return this.svc.menuOptions(await this.resolve(req, u, false));
  }

  @Post('aliases')
  async addAlias(@CurrentUser() u: AuthUser, @Req() req: any, @Body() b: Body_) {
    return this.svc.addAlias(await this.resolve(req, u, true), this.actor(u, req), { kind: b.kind, alias: b.alias, targetId: b.targetId, targetName: b.targetName });
  }

  @Delete('aliases/:aid')
  async deleteAlias(@CurrentUser() u: AuthUser, @Req() req: any, @Param('aid') aid: string) {
    return this.svc.deleteAlias(await this.resolve(req, u, true), this.actor(u, req), aid);
  }

  @Post('synonyms')
  async addSynonym(@CurrentUser() u: AuthUser, @Req() req: any, @Body() b: Body_) {
    return this.svc.addSynonym(await this.resolve(req, u, true), this.actor(u, req), { term: b.term, alternates: b.alternates });
  }

  @Patch('synonyms/:sid')
  async updateSynonym(@CurrentUser() u: AuthUser, @Req() req: any, @Param('sid') sid: string, @Body() b: Body_) {
    return this.svc.updateSynonym(await this.resolve(req, u, true), this.actor(u, req), sid, { term: b.term, alternates: b.alternates });
  }

  @Delete('synonyms/:sid')
  async deleteSynonym(@CurrentUser() u: AuthUser, @Req() req: any, @Param('sid') sid: string) {
    return this.svc.deleteSynonym(await this.resolve(req, u, true), this.actor(u, req), sid);
  }

  // ---- documents
  @Get('documents')
  async documents(@CurrentUser() u: AuthUser, @Req() req: any) {
    return this.svc.listDocuments(await this.resolve(req, u, false));
  }

  @Post('documents')
  async addDocument(@CurrentUser() u: AuthUser, @Req() req: any, @Body() b: Body_) {
    return this.svc.saveDocument(await this.resolve(req, u, true), this.actor(u, req), null, { title: b.title, text: b.text });
  }

  @Patch('documents/:did')
  async updateDocument(@CurrentUser() u: AuthUser, @Req() req: any, @Param('did') did: string, @Body() b: Body_) {
    return this.svc.saveDocument(await this.resolve(req, u, true), this.actor(u, req), did, { title: b.title, text: b.text });
  }

  @Delete('documents/:did')
  async deleteDocument(@CurrentUser() u: AuthUser, @Req() req: any, @Param('did') did: string) {
    return this.svc.deleteDocument(await this.resolve(req, u, true), this.actor(u, req), did);
  }

  // ---- unanswered inbox + feedback
  @Get('unanswered')
  async unanswered(@CurrentUser() u: AuthUser, @Req() req: any, @Query('status') status?: string) {
    return this.svc.unanswered(await this.resolve(req, u, false), status ? String(status).toUpperCase() : 'OPEN');
  }

  @Post('unanswered/:uid/teach')
  async teach(@CurrentUser() u: AuthUser, @Req() req: any, @Param('uid') uid: string, @Body() b: Body_) {
    return this.svc.teachFromUnanswered(await this.resolve(req, u, true), this.actor(u, req), uid, { title: b.title, answer: b.answer, questions: b.questions, chips: b.chips, tags: b.tags });
  }

  @Post('unanswered/:uid/merge')
  async merge(@CurrentUser() u: AuthUser, @Req() req: any, @Param('uid') uid: string, @Body() b: Body_) {
    if (typeof b.entryId !== 'string') throw new BadRequestException('entryId is required');
    return this.svc.mergeUnanswered(await this.resolve(req, u, true), this.actor(u, req), uid, b.entryId);
  }

  @Post('unanswered/:uid/ignore')
  async ignore(@CurrentUser() u: AuthUser, @Req() req: any, @Param('uid') uid: string) {
    return this.svc.ignoreUnanswered(await this.resolve(req, u, true), this.actor(u, req), uid, false);
  }

  @Post('unanswered/:uid/restore')
  async restore(@CurrentUser() u: AuthUser, @Req() req: any, @Param('uid') uid: string) {
    return this.svc.ignoreUnanswered(await this.resolve(req, u, true), this.actor(u, req), uid, true);
  }

  @Get('feedback-review')
  async feedbackReview(@CurrentUser() u: AuthUser, @Req() req: any) {
    return this.svc.feedbackReview(await this.resolve(req, u, false));
  }

  @Post('feedback-review/:eid/dismiss')
  async dismiss(@CurrentUser() u: AuthUser, @Req() req: any, @Param('eid') eid: string) {
    return this.svc.dismissReview(await this.resolve(req, u, true), this.actor(u, req), eid);
  }

  // ---- test bench
  @Post('test')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async test(@CurrentUser() u: AuthUser, @Req() req: any, @Body() b: Body_) {
    return this.svc.playground(await this.resolve(req, u, false), b.question);
  }

  @Get('test-cases')
  async testCases(@CurrentUser() u: AuthUser, @Req() req: any) {
    return this.svc.testCases(await this.resolve(req, u, false));
  }

  @Post('test-cases/run')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async runTests(@CurrentUser() u: AuthUser, @Req() req: any) {
    return this.svc.runTests(await this.resolve(req, u, false));
  }

  @Post('test-cases')
  async addTestCase(@CurrentUser() u: AuthUser, @Req() req: any, @Body() b: Body_) {
    return this.svc.addTestCase(await this.resolve(req, u, true), this.actor(u, req), { question: b.question, expectEntryId: b.expectEntryId, expectPhrase: b.expectPhrase, expectUnanswered: b.expectUnanswered });
  }

  @Delete('test-cases/:tid')
  async deleteTestCase(@CurrentUser() u: AuthUser, @Req() req: any, @Param('tid') tid: string) {
    return this.svc.deleteTestCase(await this.resolve(req, u, true), this.actor(u, req), tid);
  }

  // ---- versions / publish
  @Get('versions')
  async versions(@CurrentUser() u: AuthUser, @Req() req: any) {
    return this.svc.versions(await this.resolve(req, u, false));
  }

  @Post('versions/publish')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async publish(@CurrentUser() u: AuthUser, @Req() req: any, @Body() b: Body_) {
    if (b.confirmRegressions !== undefined && typeof b.confirmRegressions !== 'boolean') throw new BadRequestException('confirmRegressions must be true or false');
    return this.svc.publish(await this.resolve(req, u, true), this.actor(u, req), { note: typeof b.note === 'string' ? b.note : undefined, confirmRegressions: b.confirmRegressions === true });
  }

  @Get('versions/:n')
  async version(@CurrentUser() u: AuthUser, @Req() req: any, @Param('n') n: string) {
    const v = int(n);
    if (!v || v < 1) throw new BadRequestException('Invalid version');
    return this.svc.versionDetail(await this.resolve(req, u, false), v);
  }

  @Post('versions/:n/rollback')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async rollback(@CurrentUser() u: AuthUser, @Req() req: any, @Param('n') n: string, @Body() b: Body_) {
    const v = int(n);
    if (!v || v < 1) throw new BadRequestException('Invalid version');
    return this.svc.rollback(await this.resolve(req, u, true), this.actor(u, req), v, { note: typeof b.note === 'string' ? b.note : undefined });
  }

  @Post('draft/discard')
  async discard(@CurrentUser() u: AuthUser, @Req() req: any) {
    return this.svc.discardDraft(await this.resolve(req, u, true), this.actor(u, req));
  }

  @Get('requests')
  async requests(@CurrentUser() u: AuthUser, @Req() req: any) {
    return this.svc.myRequests(await this.resolve(req, u, false));
  }

  @Post('requests/:id/cancel')
  async cancel(@CurrentUser() u: AuthUser, @Req() req: any, @Param('id') id: string) {
    return this.svc.cancelRequest(await this.resolve(req, u, true), this.actor(u, req), id);
  }

  // ---- settings
  @Get('settings')
  async settings(@CurrentUser() u: AuthUser, @Req() req: any) {
    return this.svc.getSettings(await this.resolve(req, u, false));
  }

  @Patch('settings')
  async setSettings(@CurrentUser() u: AuthUser, @Req() req: any, @Body() b: Body_) {
    return this.svc.setSettings(await this.resolve(req, u, true), this.actor(u, req), { threshold: b.threshold });
  }

  // ---- import / export
  @Get('export')
  async exportJson(@CurrentUser() u: AuthUser, @Req() req: any) {
    return this.svc.exportJson(await this.resolve(req, u, false));
  }

  @Get('export.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="assistant-answers.csv"')
  async exportCsv(@CurrentUser() u: AuthUser, @Req() req: any) {
    return this.svc.exportCsv(await this.resolve(req, u, false));
  }

  @Post('import')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async importJson(@CurrentUser() u: AuthUser, @Req() req: any, @Body() b: Body_) {
    return this.svc.importJson(await this.resolve(req, u, true), this.actor(u, req), { data: b.data, mode: b.mode, replace: b.replace === true });
  }

  @Post('import-csv')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async importCsv(@CurrentUser() u: AuthUser, @Req() req: any, @Body() b: Body_) {
    if (typeof b.csv !== 'string') throw new BadRequestException('csv must be text');
    return this.svc.importCsv(await this.resolve(req, u, true), this.actor(u, req), { csv: b.csv, mode: b.mode, replace: b.replace === true });
  }

  // ---- staff only: answers held by a guardrail
  @Post('held/:kind/:id/release')
  async release(@CurrentUser() u: AuthUser, @Req() req: any, @Param('kind') kind: string, @Param('id') id: string) {
    this.staffOnly(u);
    if (kind !== 'entry' && kind !== 'document') throw new BadRequestException('kind must be entry or document');
    return this.svc.releaseHeld(await this.resolve(req, u, true), this.actor(u, req), kind, id, true);
  }

  @Post('held/:kind/:id/reject')
  async rejectHeld(@CurrentUser() u: AuthUser, @Req() req: any, @Param('kind') kind: string, @Param('id') id: string) {
    this.staffOnly(u);
    if (kind !== 'entry' && kind !== 'document') throw new BadRequestException('kind must be entry or document');
    return this.svc.releaseHeld(await this.resolve(req, u, true), this.actor(u, req), kind, id, false);
  }
}

// ------------------------------------------------------------------ restaurant portal
@RestaurantController('assistant/training')
export class RestaurantTrainingController extends TrainingBase {
  constructor(svc: TrainingService) {
    super(svc); // explicit: Nest reads the constructor types of the concrete controller
  }

  protected async resolve(req: any, user: AuthUser, write: boolean): Promise<TScope> {
    const rid = resolveRestaurantId(user, typeof req.query?.restaurantId === 'string' ? req.query.restaurantId : undefined);
    if (write && !MANAGERS.includes(user.restaurantRole as RestaurantRole)) throw new ForbiddenException('Only the owner or a location manager can train the assistant');
    return this.svc.scopeOfRestaurant(rid);
  }
}

// ------------------------------------------------------------------ admin console: any restaurant
@AdminController('assistant/training/restaurants/:rid')
export class AdminRestaurantTrainingController extends TrainingBase {
  constructor(svc: TrainingService) {
    super(svc); // explicit: Nest reads the constructor types of the concrete controller
  }

  protected async resolve(req: any, user: AuthUser, write: boolean): Promise<TScope> {
    if (!hasPermission(user, Mod.RESTAURANTS, write ? Action.EDIT : Action.VIEW)) throw new ForbiddenException(`Missing permission: restaurants:${write ? 'edit' : 'view'}`);
    const rid = String(req.params?.rid ?? '');
    if (!UUID.test(rid)) throw new BadRequestException('Invalid restaurant id');
    return this.svc.scopeOfRestaurant(rid);
  }
}

// ------------------------------------------------------------------ admin console: the FORKSY website bot
@AdminController('assistant/training/central')
export class AdminCentralTrainingController extends TrainingBase {
  constructor(svc: TrainingService) {
    super(svc); // explicit: Nest reads the constructor types of the concrete controller
  }

  protected async resolve(_req: any, user: AuthUser, write: boolean): Promise<TScope> {
    if (!hasPermission(user, Mod.SETTINGS, write ? Action.EDIT : Action.VIEW)) throw new ForbiddenException(`Missing permission: settings:${write ? 'edit' : 'view'}`);
    return this.svc.centralScope();
  }
}

// ------------------------------------------------------------------ admin console: platform view, approvals
@AdminController('assistant/training')
export class AdminTrainingController {
  constructor(private svc: TrainingService) {}

  private actor(user: AuthUser, req: any): TActor {
    return { id: user.id, name: user.name || user.email || 'staff', type: 'staff', req };
  }

  @Get('overview')
  @Permission(Mod.RESTAURANTS, Action.VIEW)
  overview() {
    return this.svc.platformOverview();
  }

  @Get('restaurants')
  @Permission(Mod.RESTAURANTS, Action.VIEW)
  coverage(@Query() q: Body_) {
    return this.svc.coverage({ search: typeof q.search === 'string' ? q.search.slice(0, 100) : undefined, page: int(q.page), limit: int(q.limit), sortBy: q.sortBy, sortDir: q.sortDir });
  }

  @Get('requests')
  @Permission(Mod.RESTAURANTS, Action.VIEW)
  requests(@Query() q: Body_) {
    return this.svc.listRequests(typeof q.status === 'string' ? q.status.toUpperCase() : 'PENDING', int(q.page, 1), Math.min(100, int(q.limit, 20) ?? 20));
  }

  @Get('requests/:id')
  @Permission(Mod.RESTAURANTS, Action.VIEW)
  request(@Param('id') id: string) {
    if (!UUID.test(id)) throw new BadRequestException('Invalid request id');
    return this.svc.requestDetail(id);
  }

  @Post('requests/:id/approve')
  @Permission(Mod.RESTAURANTS, Action.EDIT)
  approve(@Param('id') id: string, @CurrentUser() u: AuthUser, @Req() req: any, @Body() b: Body_) {
    if (!UUID.test(id)) throw new BadRequestException('Invalid request id');
    return this.svc.decide(id, this.actor(u, req), true, typeof b.note === 'string' ? b.note : null);
  }

  @Post('requests/:id/reject')
  @Permission(Mod.RESTAURANTS, Action.EDIT)
  reject(@Param('id') id: string, @CurrentUser() u: AuthUser, @Req() req: any, @Body() b: Body_) {
    if (!UUID.test(id)) throw new BadRequestException('Invalid request id');
    return this.svc.decide(id, this.actor(u, req), false, typeof b.note === 'string' ? b.note : null);
  }

  @Get('held')
  @Permission(Mod.RESTAURANTS, Action.VIEW)
  held() {
    return this.svc.heldQueue();
  }
}
