import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { City, DriverShift, Incentive, Order, SosAlert, TrainingModule, Zone } from '../database/entities';
import { ACTIVE_ORDER_STATUSES } from '../common/enums';
import { AuthUser } from '../common/auth.types';
import { paginateQb } from '../common/pagination';
import { DriverCoreService } from './driver-core.service';
import { round2 } from './drivers.util';
import {
  AnalyticsQuery,
  ExpiringDocsQuery,
  IncentiveDto,
  IncentiveListQuery,
  ShiftListQuery,
  ShiftSlotDto,
  SosListQuery,
  SupplyAlertDto,
  TrainingModuleDto,
  UpdateIncentiveDto,
  UpdateSlotDto,
  UpdateTrainingModuleDto,
} from './drivers.dto';

/**
 * Admin "operations" surface: incentives/boosts, supply alerts, shift slots, training module
 * authoring, SOS handling, expiring-document queue and the ops heat-map / performance rollups.
 * Kept out of DriversAdminService (pipeline + CRUD) to keep files under the ~600 line guideline.
 */
@Injectable()
export class DriverOpsService {
  constructor(
    private core: DriverCoreService,
    @InjectRepository(DriverShift) private shifts: Repository<DriverShift>,
    @InjectRepository(SosAlert) private sosRepo: Repository<SosAlert>,
    @InjectRepository(Zone) private zones: Repository<Zone>,
    @InjectRepository(City) private cities: Repository<City>,
    @InjectRepository(Order) private orders: Repository<Order>,
  ) {}

  // ------------------------------------------------------------------ incentives / boosts
  async listIncentives(q: IncentiveListQuery) {
    const qb = this.core.incentives.createQueryBuilder('i');
    if (q.zoneId) qb.andWhere('i.zoneId = :z', { z: q.zoneId });
    if (q.cityId) qb.andWhere('i.cityId = :c', { c: q.cityId });
    if (q.driverId) qb.andWhere('i.driverId = :d', { d: q.driverId });
    if (q.type) qb.andWhere('i.type = :t', { t: q.type });
    if (q.active === 'true') qb.andWhere('i.active = true AND i.endsAt >= NOW()');
    if (q.active === 'false') qb.andWhere('(i.active = false OR i.endsAt < NOW())');
    return paginateQb(qb, q, { sortable: { startsAt: 'i.startsAt', endsAt: 'i.endsAt', createdAt: 'i.createdAt' }, defaultSort: ['i.createdAt', 'DESC'] });
  }

  async createIncentive(dto: IncentiveDto) {
    if (new Date(dto.startsAt) >= new Date(dto.endsAt)) throw new BadRequestException('startsAt must be before endsAt');
    if (dto.zoneId && !(await this.zones.findOne({ where: { id: dto.zoneId } }))) throw new BadRequestException('Unknown zone');
    return this.core.incentives.save(
      this.core.incentives.create({
        name: dto.name,
        description: dto.description ?? null,
        type: dto.type,
        zoneId: dto.zoneId ?? null,
        cityId: dto.cityId ?? null,
        driverId: dto.driverId ?? null,
        amountPerTrip: dto.amountPerTrip ?? 0,
        percentBoost: dto.percentBoost ?? 0,
        questTrips: dto.questTrips ?? null,
        bonusAmount: dto.bonusAmount ?? 0,
        startsAt: new Date(dto.startsAt),
        endsAt: new Date(dto.endsAt),
        daysOfWeek: dto.daysOfWeek ?? [],
        startTime: dto.startTime ?? null,
        endTime: dto.endTime ?? null,
        active: dto.active ?? true,
      }),
    );
  }

  private async getIncentive(id: string): Promise<Incentive> {
    const i = await this.core.incentives.findOne({ where: { id } });
    if (!i) throw new NotFoundException('Incentive not found');
    return i;
  }

  async updateIncentive(id: string, dto: UpdateIncentiveDto) {
    const i = await this.getIncentive(id);
    if (dto.name !== undefined) i.name = dto.name;
    if (dto.description !== undefined) i.description = dto.description;
    if (dto.zoneId !== undefined) i.zoneId = dto.zoneId;
    if (dto.cityId !== undefined) i.cityId = dto.cityId;
    if (dto.amountPerTrip !== undefined) i.amountPerTrip = dto.amountPerTrip;
    if (dto.percentBoost !== undefined) i.percentBoost = dto.percentBoost;
    if (dto.questTrips !== undefined) i.questTrips = dto.questTrips;
    if (dto.bonusAmount !== undefined) i.bonusAmount = dto.bonusAmount;
    if (dto.startsAt !== undefined) i.startsAt = new Date(dto.startsAt);
    if (dto.endsAt !== undefined) i.endsAt = new Date(dto.endsAt);
    if (dto.daysOfWeek !== undefined) i.daysOfWeek = dto.daysOfWeek;
    if (dto.startTime !== undefined) i.startTime = dto.startTime;
    if (dto.endTime !== undefined) i.endTime = dto.endTime;
    if (dto.active !== undefined) i.active = dto.active;
    return this.core.incentives.save(i);
  }

  async deleteIncentive(id: string) {
    const i = await this.getIncentive(id);
    await this.core.incentives.remove(i);
    return { ok: true };
  }

  /** Ops "send supply alert" button (open/close checklist item): boost a zone for N minutes. */
  async supplyAlert(dto: SupplyAlertDto, admin: AuthUser) {
    const zone = await this.zones.findOne({ where: { id: dto.zoneId } });
    if (!zone) throw new BadRequestException('Unknown zone');
    const minutes = dto.durationMinutes ?? 60;
    const startsAt = new Date();
    const endsAt = new Date(startsAt.getTime() + minutes * 60000);
    const incentive = await this.core.incentives.save(
      this.core.incentives.create({
        name: `Supply alert - ${zone.name}`,
        description: dto.message ?? `High demand in ${zone.name}. Extra $${dto.boostAmount.toFixed(2)}/trip for the next ${minutes} min.`,
        type: 'SUPPLY_ALERT',
        zoneId: zone.id,
        cityId: zone.cityId,
        amountPerTrip: dto.boostAmount,
        percentBoost: 0,
        questTrips: null,
        bonusAmount: 0,
        startsAt,
        endsAt,
        daysOfWeek: [],
        active: true,
      }),
    );
    const body = dto.message ?? `Extra $${dto.boostAmount.toFixed(2)} per trip in ${zone.name} for the next ${minutes} minutes. Go online now!`;
    this.core.rt.emitToZone(zone.id, 'driver.supply_alert', { zoneId: zone.id, boostAmount: dto.boostAmount, endsAt, message: body });
    if (dto.includeOnline ?? true) {
      const online = await this.core.profiles.find({ where: { activeZoneId: zone.id, isOnline: true }, select: ['id', 'userId'] });
      await Promise.all(
        online.map((d) => this.core.notifications.notify({ userId: d.userId, audience: 'DRIVER', event: 'driver.supply_alert', data: { zoneId: zone.id }, title: 'Extra pay is live nearby', body })),
      );
    }
    await this.core.opsNotify('driver.supply_alert', `Supply alert sent - ${zone.name}`, `${admin.name} boosted ${zone.name} by $${dto.boostAmount.toFixed(2)}/trip for ${minutes} min.`, { zoneId: zone.id });
    return incentive;
  }

  // ------------------------------------------------------------------ shifts (admin: publish slots)
  async listShiftSlots(q: ShiftListQuery) {
    const qb = this.shifts.createQueryBuilder('s').where('s.driverId IS NULL');
    if (q.zoneId) qb.andWhere('s.zoneId = :z', { z: q.zoneId });
    if (q.status) qb.andWhere('s.status = :st', { st: q.status });
    if (q.from) qb.andWhere('s.startsAt >= :f', { f: q.from });
    if (q.to) qb.andWhere('s.endsAt <= :t', { t: q.to });
    const res = await paginateQb(qb, q, { sortable: { startsAt: 's.startsAt' }, defaultSort: ['s.startsAt', 'ASC'] });
    const booked = await this.bookedCounts(res.data);
    return { data: res.data.map((s) => ({ ...s, booked: booked.get(s.id) ?? 0 })), meta: res.meta };
  }

  /** Booked/started/completed count per open slot, matched by zone + exact time window. */
  private async bookedCounts(slots: DriverShift[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    await Promise.all(
      slots.map(async (s) => {
        const c = await this.shifts.count({
          where: { zoneId: s.zoneId, startsAt: s.startsAt, endsAt: s.endsAt, status: In(['BOOKED', 'STARTED', 'COMPLETED']) as any },
        });
        out.set(s.id, c);
      }),
    );
    return out;
  }

  async createShiftSlot(dto: ShiftSlotDto) {
    if (!(await this.zones.findOne({ where: { id: dto.zoneId } }))) throw new BadRequestException('Unknown zone');
    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);
    if (startsAt >= endsAt) throw new BadRequestException('startsAt must be before endsAt');
    return this.shifts.save(this.shifts.create({ driverId: null, zoneId: dto.zoneId, startsAt, endsAt, status: 'OPEN', slotCapacity: dto.capacity }));
  }

  async updateShiftSlot(id: string, dto: UpdateSlotDto) {
    const s = await this.shifts.findOne({ where: { id } });
    if (!s || s.driverId) throw new NotFoundException('Slot not found');
    if (s.status !== 'OPEN') throw new BadRequestException('Only an open slot can be edited');
    if (dto.capacity !== undefined) s.slotCapacity = dto.capacity;
    if (dto.startsAt !== undefined) s.startsAt = new Date(dto.startsAt);
    if (dto.endsAt !== undefined) s.endsAt = new Date(dto.endsAt);
    return this.shifts.save(s);
  }

  async cancelShiftSlot(id: string) {
    const s = await this.shifts.findOne({ where: { id } });
    if (!s || s.driverId) throw new NotFoundException('Slot not found');
    s.status = 'CANCELLED';
    await this.shifts.save(s);
    return { ok: true };
  }

  /** Every booked/started/completed shift, for the ops schedule view. */
  async listShifts(q: ShiftListQuery) {
    const qb = this.shifts.createQueryBuilder('s').where('s.driverId IS NOT NULL');
    if (q.zoneId) qb.andWhere('s.zoneId = :z', { z: q.zoneId });
    if (q.driverId) qb.andWhere('s.driverId = :d', { d: q.driverId });
    if (q.status) qb.andWhere('s.status = :st', { st: q.status });
    if (q.from) qb.andWhere('s.startsAt >= :f', { f: q.from });
    if (q.to) qb.andWhere('s.endsAt <= :t', { t: q.to });
    return paginateQb(qb, q, { sortable: { startsAt: 's.startsAt' }, defaultSort: ['s.startsAt', 'ASC'] });
  }

  // ------------------------------------------------------------------ training modules (authoring)
  async listModules() {
    return this.core.modules.find({ order: { sortOrder: 'ASC' } });
  }

  async createModule(dto: TrainingModuleDto) {
    return this.core.modules.save(
      this.core.modules.create({ title: dto.title, content: dto.content, sortOrder: dto.sortOrder ?? 0, quiz: dto.quiz ?? [], passMark: dto.passMark ?? 80, active: dto.active ?? true }),
    );
  }

  private async getModule(id: string): Promise<TrainingModule> {
    const m = await this.core.modules.findOne({ where: { id } });
    if (!m) throw new NotFoundException('Training module not found');
    return m;
  }

  async updateModule(id: string, dto: UpdateTrainingModuleDto) {
    const m = await this.getModule(id);
    if (dto.title !== undefined) m.title = dto.title;
    if (dto.content !== undefined) m.content = dto.content;
    if (dto.sortOrder !== undefined) m.sortOrder = dto.sortOrder;
    if (dto.quiz !== undefined) m.quiz = dto.quiz;
    if (dto.passMark !== undefined) m.passMark = dto.passMark;
    if (dto.active !== undefined) m.active = dto.active;
    return this.core.modules.save(m);
  }

  async deleteModule(id: string) {
    const m = await this.getModule(id);
    await this.core.modules.remove(m);
    return { ok: true };
  }

  // ------------------------------------------------------------------ SOS (admin)
  async listSos(q: SosListQuery) {
    const qb = this.sosRepo.createQueryBuilder('s');
    if (q.status) qb.andWhere('s.status = :st', { st: q.status });
    if (q.driverId) qb.andWhere('s.driverId = :d', { d: q.driverId });
    return paginateQb(qb, q, { sortable: { createdAt: 's.createdAt' }, defaultSort: ['s.createdAt', 'DESC'] });
  }

  private async getSos(id: string): Promise<SosAlert> {
    const s = await this.sosRepo.findOne({ where: { id } });
    if (!s) throw new NotFoundException('SOS alert not found');
    return s;
  }

  async acknowledgeSos(id: string, admin: AuthUser, note?: string) {
    const s = await this.getSos(id);
    if (s.status === 'OPEN') s.status = 'ACKNOWLEDGED';
    s.handledById = admin.id;
    s.handledAt = new Date();
    await this.sosRepo.save(s);
    const d = await this.core.getProfile(s.driverId);
    await this.core.notifyDriver(d, 'sos.acknowledged', {}, {}, { title: 'Help is on the way', body: note || 'Dispatch has your SOS alert and is responding.' });
    return s;
  }

  async resolveSos(id: string, admin: AuthUser, note?: string) {
    const s = await this.getSos(id);
    s.status = 'RESOLVED';
    s.handledById = admin.id;
    s.handledAt = new Date();
    if (note) s.message = `${s.message ?? ''}\n[resolved] ${note}`.trim();
    return this.sosRepo.save(s);
  }

  // ------------------------------------------------------------------ expiring documents queue
  async expiringDocuments(q: ExpiringDocsQuery) {
    const days = q.days ?? 30;
    const qb = this.core.docs
      .createQueryBuilder('dd')
      .where('dd.status IN (:...st)', { st: ['APPROVED', 'EXPIRED'] })
      .andWhere('dd."expiresAt" IS NOT NULL')
      .andWhere(`dd."expiresAt" <= (CURRENT_DATE + :d::int)`, { d: days });
    if (q.type) qb.andWhere('dd.type = :t', { t: q.type });
    const res = await paginateQb(qb, q, { sortable: { expiresAt: 'dd.expiresAt' }, defaultSort: ['dd.expiresAt', 'ASC'] });
    const driverIds = [...new Set(res.data.map((d) => d.driverId))];
    const drivers = driverIds.length ? await this.core.profiles.find({ where: { id: In(driverIds) }, relations: ['user'] }) : [];
    const byId = new Map(drivers.map((d) => [d.id, d]));
    return {
      data: res.data.map((d) => {
        const driver = byId.get(d.driverId);
        return { id: d.id, driverId: d.driverId, driverName: driver ? this.core.driverName(driver) : null, type: d.type, status: d.status, expiresAt: d.expiresAt, fileUrl: d.fileUrl };
      }),
      meta: res.meta,
    };
  }

  // ------------------------------------------------------------------ heat map + analytics
  /** Online / on-trip drivers vs open orders per zone, for the ops heat-map. */
  async heatMap(cityId?: string) {
    const zoneQb = this.zones.createQueryBuilder('z').where('z.active = true');
    if (cityId) zoneQb.andWhere('z.cityId = :c', { c: cityId });
    const zones = await zoneQb.getMany();
    const driverRows: { activeZoneId: string; online: number; onTrip: number }[] = await this.core.profiles.manager.query(
      `SELECT "activeZoneId", COUNT(*) FILTER (WHERE "isOnline")::int AS online, COUNT(*) FILTER (WHERE "onTrip")::int AS "onTrip"
       FROM driver_profiles WHERE "activeZoneId" IS NOT NULL GROUP BY "activeZoneId"`,
    );
    const orderRows: { zoneId: string; c: string }[] = await this.orders
      .createQueryBuilder('o')
      .select('o.zoneId', 'zoneId')
      .addSelect('COUNT(*)', 'c')
      .where('o.status IN (:...st)', { st: ACTIVE_ORDER_STATUSES })
      .andWhere('o.zoneId IS NOT NULL')
      .groupBy('o.zoneId')
      .getRawMany();
    const dByZone = new Map(driverRows.map((r) => [r.activeZoneId, r]));
    const oByZone = new Map(orderRows.map((r) => [r.zoneId, Number(r.c)]));
    return zones.map((z) => {
      const d = dByZone.get(z.id);
      const online = d?.online ?? 0;
      const openOrders = oByZone.get(z.id) ?? 0;
      return {
        zoneId: z.id,
        zoneName: z.name,
        cityId: z.cityId,
        centerLat: z.centerLat,
        centerLng: z.centerLng,
        onlineDrivers: online,
        onTripDrivers: d?.onTrip ?? 0,
        openOrders,
        demandScore: online > 0 ? round2(openOrders / online) : openOrders > 0 ? 99 : 0,
      };
    });
  }

  /** Driver performance leaderboard + fleet totals for a rolling window. */
  async analytics(q: AnalyticsQuery) {
    const days = q.days ?? 7;
    const since = new Date(Date.now() - days * 86400000);
    const limit = q.limit ?? 20;
    const profileQb = this.core.profiles.createQueryBuilder('d');
    if (q.cityId) profileQb.andWhere('d.cityId = :c', { c: q.cityId });
    const fleet = await profileQb
      .select('COUNT(*) FILTER (WHERE d.status = \'ACTIVE\')', 'active')
      .addSelect('COUNT(*) FILTER (WHERE d."isOnline")', 'online')
      .addSelect('AVG(d.rating)', 'avgRating')
      .addSelect('AVG(d."acceptanceRate")', 'avgAcceptance')
      .addSelect('AVG(d."completionRate")', 'avgCompletion')
      .getRawOne<{ active: string; online: string; avgRating: string; avgAcceptance: string; avgCompletion: string }>();
    const tripsQb = this.orders
      .createQueryBuilder('o')
      .select('o.driverId', 'driverId')
      .addSelect('COUNT(*)', 'trips')
      .addSelect('COALESCE(SUM(o."driverPay"),0)', 'pay')
      .addSelect('COALESCE(SUM(o.tip),0)', 'tips')
      .where('o.status IN (:...st)', { st: ['DELIVERED', 'COLLECTED'] })
      .andWhere('o."deliveredAt" >= :since', { since })
      .andWhere('o."driverId" IS NOT NULL')
      .groupBy('o.driverId')
      .orderBy('COUNT(*)', 'DESC')
      .limit(limit);
    if (q.zoneId) tripsQb.andWhere('o.zoneId = :z', { z: q.zoneId });
    const topRows = await tripsQb.getRawMany<{ driverId: string; trips: string; pay: string; tips: string }>();
    const ids = topRows.map((r) => r.driverId);
    const drivers = ids.length ? await this.core.profiles.find({ where: { id: In(ids) }, relations: ['user'] }) : [];
    const byId = new Map(drivers.map((d) => [d.id, d]));
    return {
      windowDays: days,
      fleet: {
        activeDrivers: Number(fleet?.active ?? 0),
        onlineNow: Number(fleet?.online ?? 0),
        avgRating: fleet?.avgRating ? round2(Number(fleet.avgRating)) : null,
        avgAcceptanceRate: fleet?.avgAcceptance ? round2(Number(fleet.avgAcceptance)) : null,
        avgCompletionRate: fleet?.avgCompletion ? round2(Number(fleet.avgCompletion)) : null,
      },
      topDrivers: topRows.map((r) => {
        const d = byId.get(r.driverId);
        return { driverId: r.driverId, name: d ? this.core.driverName(d) : 'Unknown', trips: Number(r.trips), pay: round2(Number(r.pay)), tips: round2(Number(r.tips)), rating: d?.rating ?? null };
      }),
    };
  }
}
