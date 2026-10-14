import { DataSource } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { City, DriverDocument, DriverOffer, DriverProfile, TrainingModule, User, Zone } from '../database/entities';
import { DocStatus, DriverDocType, DriverStatus, OfferStatus, UserStatus, UserType, VehicleType, VerificationMethod, VerificationStatus } from '../common/enums';
import { SeedOptions } from '../database/seed-types';

type Plan = { first: string; last: string; status: DriverStatus; online?: boolean; vehicle: VehicleType; docs: 'all' | 'some' | 'none'; bg: DriverProfile['backgroundCheckStatus']; reason?: string };

const PLANS: Plan[] = [
  { first: 'Liam', last: 'Tremblay', status: DriverStatus.ACTIVE, online: true, vehicle: VehicleType.CAR, docs: 'all', bg: 'CLEAR' },
  { first: 'Maya', last: 'Singh', status: DriverStatus.ACTIVE, online: true, vehicle: VehicleType.E_BIKE, docs: 'all', bg: 'CLEAR' },
  { first: 'Noah', last: 'Campbell', status: DriverStatus.ACTIVE, online: true, vehicle: VehicleType.CAR, docs: 'all', bg: 'CLEAR' },
  { first: 'Priya', last: 'Patel', status: DriverStatus.ACTIVE, online: true, vehicle: VehicleType.SCOOTER, docs: 'all', bg: 'CLEAR' },
  { first: 'Omar', last: 'Haddad', status: DriverStatus.ACTIVE, vehicle: VehicleType.CAR, docs: 'all', bg: 'CLEAR' },
  { first: 'Chloe', last: 'Martin', status: DriverStatus.ACTIVE, vehicle: VehicleType.CAR, docs: 'all', bg: 'CLEAR' },
  { first: 'Ethan', last: 'Wong', status: DriverStatus.APPROVED, vehicle: VehicleType.CAR, docs: 'all', bg: 'CLEAR' },
  { first: 'Sofia', last: 'Rossi', status: DriverStatus.TRAINING, vehicle: VehicleType.CAR, docs: 'all', bg: 'CLEAR' },
  { first: 'Jamal', last: 'Brown', status: DriverStatus.BACKGROUND_CHECK, vehicle: VehicleType.CAR, docs: 'all', bg: 'IN_PROGRESS' },
  { first: 'Aisha', last: 'Khan', status: DriverStatus.DOCS_REVIEW, vehicle: VehicleType.BIKE, docs: 'some', bg: 'NOT_STARTED' },
  { first: 'Lucas', last: 'Gagnon', status: DriverStatus.APPLIED, vehicle: VehicleType.CAR, docs: 'none', bg: 'NOT_STARTED' },
  { first: 'Zoe', last: 'Fraser', status: DriverStatus.SUSPENDED, vehicle: VehicleType.CAR, docs: 'all', bg: 'CLEAR', reason: 'Multiple late deliveries under review' },
  { first: 'Victor', last: 'Petrov', status: DriverStatus.DEACTIVATED, vehicle: VehicleType.CAR, docs: 'all', bg: 'CLEAR', reason: 'Safety complaint upheld' },
  { first: 'Dana', last: 'Lee', status: DriverStatus.REJECTED, vehicle: VehicleType.CAR, docs: 'some', bg: 'CONSIDER', reason: 'Background check not cleared' },
];

const DEFAULT_MODULES = [
  { title: 'Safety and food handling', content: 'Keep food upright, use the insulated bag, never leave orders unattended.', sortOrder: 1, quiz: [{ question: 'What must you use to carry food?', options: ['Insulated bag', 'Open hands', 'Trunk loose'], correctIndex: 0 }, { question: 'Can you leave an order unattended?', options: ['Yes', 'No'], correctIndex: 1 }] },
  { title: 'Using the driver app', content: 'Accept offers, confirm pickup with the order code, take a photo at drop-off.', sortOrder: 2, quiz: [{ question: 'How do you confirm pickup?', options: ['Order code', 'Nothing', 'Call support'], correctIndex: 0 }, { question: 'Proof of delivery is...', options: ['A photo or PIN', 'Optional always'], correctIndex: 0 }] },
];

const DOC_TYPES = [DriverDocType.LICENCE, DriverDocType.VEHICLE_REGISTRATION, DriverDocType.INSURANCE, DriverDocType.PHOTO, DriverDocType.WORK_ELIGIBILITY];

/** ~14 demo drivers in every status. Idempotent: looks up users by email, modules by title. */
export async function seedDrivers(ds: DataSource, opts: SeedOptions): Promise<void> {
  const modules = ds.getRepository(TrainingModule);
  for (const m of DEFAULT_MODULES) {
    if (!(await modules.findOne({ where: { title: m.title } }))) await modules.save(modules.create({ ...m, passMark: 80, active: true }));
  }
  if (!opts.demo) return;

  const users = ds.getRepository(User);
  const profiles = ds.getRepository(DriverProfile);
  const docsRepo = ds.getRepository(DriverDocument);
  const city = (await ds.getRepository(City).findOne({ where: { name: 'Mississauga' } })) ?? (await ds.getRepository(City).find({ take: 1 }))[0] ?? null;
  const zones = city ? await ds.getRepository(Zone).find({ where: { cityId: city.id, active: true }, order: { name: 'ASC' } }) : [];
  const hash = await bcrypt.hash(opts.demoPassword, 10);
  const inFuture = (days: number) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

  for (let i = 0; i < PLANS.length; i++) {
    const n = i + 1;
    const p = PLANS[i];
    const email = `driver${n}@demo.forky.ca`;
    if (await users.findOne({ where: { email } })) continue;
    const phone = `+1416555${String(100 + n).padStart(4, '0')}`;
    const user = await users.save(
      users.create({ type: UserType.DRIVER, status: p.status === DriverStatus.DEACTIVATED ? UserStatus.SUSPENDED : UserStatus.ACTIVE, email, phone, emailVerified: true, phoneVerified: true, firstName: p.first, lastName: p.last, passwordHash: hash }),
    );
    const live = p.status === DriverStatus.ACTIVE;
    const assigned = [DriverStatus.ACTIVE, DriverStatus.APPROVED, DriverStatus.SUSPENDED, DriverStatus.DEACTIVATED].includes(p.status);
    const zone = zones.length ? zones[i % zones.length] : null;
    const postApproval = assigned || p.status === DriverStatus.TRAINING;
    await profiles.save(
      profiles.create({
        userId: user.id,
        cityId: city?.id ?? null,
        status: p.status,
        statusReason: p.reason ?? null,
        vehicleType: p.vehicle,
        vehicleMake: p.vehicle === VehicleType.CAR ? 'Toyota' : null,
        vehicleModel: p.vehicle === VehicleType.CAR ? 'Corolla' : null,
        vehicleColor: 'Grey',
        licensePlate: p.vehicle === VehicleType.CAR ? `CFKS ${100 + n}` : null,
        zoneIds: assigned && zone ? zones.slice(0, 2).map((z) => z.id).concat(zone.id).filter((v, idx, a) => a.indexOf(v) === idx) : [],
        activeZoneId: p.online && zone ? zone.id : null,
        isOnline: !!p.online,
        wentOnlineAt: p.online ? new Date() : null,
        lat: live ? 43.589 + ((n * 37) % 100) / 2500 - 0.02 : null,
        lng: live ? -79.6441 + ((n * 53) % 100) / 2500 - 0.02 : null,
        lastLocationAt: live ? new Date() : null,
        backgroundCheckProvider: p.bg === 'NOT_STARTED' ? null : 'certn-mock',
        backgroundCheckStatus: p.bg,
        backgroundCheckRef: p.bg === 'NOT_STARTED' ? null : `mock_seed_${n}`,
        trainingCompleted: postApproval && p.status !== DriverStatus.TRAINING,
        trainingScore: postApproval && p.status !== DriverStatus.TRAINING ? 90 : null,
        insulatedBagConfirmed: assigned,
        welcomeBoostSent: live,
        approvedAt: assigned ? new Date(Date.now() - (30 + n) * 86400000) : null,
        // demo drivers who went through the pipeline count as verified (method MANUAL), like the migration's backfill
        verificationStatus: assigned ? VerificationStatus.VERIFIED : p.status === DriverStatus.REJECTED ? VerificationStatus.REJECTED : VerificationStatus.PENDING,
        verificationMethod: assigned ? VerificationMethod.MANUAL : null,
        verifiedAt: assigned ? new Date(Date.now() - (30 + n) * 86400000) : null,
        bank: assigned ? { institution: '004', transit: '12345', accountLast4: String(1000 + n), holder: `${p.first} ${p.last}` } : null,
        taxInfo: assigned ? { sinLast3: String(100 + n), legalName: `${p.first} ${p.last}`, address: `${n} Hurontario St, Mississauga, ON`, collectedAt: new Date().toISOString() } : null,
        ontarioPlatformWorkerNoticeAcked: p.docs !== 'none',
        rating: live ? 4.5 + (n % 5) / 10 : 5,
        ratingCount: live ? 20 + n * 7 : 0,
        totalTrips: live ? 40 + n * 13 : 0,
        meta: assigned ? { insurance: { coversDelivery: true, expiresAt: inFuture(200), confirmedAt: new Date().toISOString() } } : {},
      }),
    );
    const prof = await profiles.findOneOrFail({ where: { userId: user.id } });
    const types = p.docs === 'all' ? DOC_TYPES : p.docs === 'some' ? DOC_TYPES.slice(0, 2) : [];
    for (const type of types) {
      const approved = p.docs === 'all' && p.status !== DriverStatus.APPLIED && p.status !== DriverStatus.DOCS_REVIEW;
      const rejected = p.status === DriverStatus.REJECTED && type === DriverDocType.VEHICLE_REGISTRATION;
      const needsExpiry = [DriverDocType.LICENCE, DriverDocType.INSURANCE, DriverDocType.VEHICLE_REGISTRATION].includes(type);
      // driver5 has an insurance expiring soon to exercise reminders
      const expiry = n === 5 && type === DriverDocType.INSURANCE ? inFuture(12) : inFuture(180 + n * 10);
      await docsRepo.save(
        docsRepo.create({
          driverId: prof.id,
          type,
          fileUrl: `/uploads/demo/driver${n}-${type.toLowerCase()}.jpg`,
          fileName: `${type.toLowerCase()}.jpg`,
          status: rejected ? DocStatus.REJECTED : approved ? DocStatus.APPROVED : DocStatus.PENDING,
          rejectReason: rejected ? 'Blurry image' : null,
          expiresAt: needsExpiry && (approved || rejected) ? expiry : needsExpiry ? expiry : null,
          reviewedAt: approved || rejected ? new Date() : null,
        }),
      );
    }
    console.log(`  + driver ${email} (${p.status}${p.online ? ', online' : ''})`);
  }
}

type ExtraPlan = Plan & { zone: string; dLat: number; dLng: number };
const B = DriverStatus.ACTIVE;
/** driver15..28: Brampton + Mississauga couriers (6 online Brampton, 5 online Mississauga, all off-trip; plus offline/approved/in-onboarding). */
const EXTRA_PLANS: ExtraPlan[] = [
  { first: 'Harpreet', last: 'Gill', status: B, online: true, vehicle: VehicleType.CAR, docs: 'all', bg: 'CLEAR', zone: 'Downtown Brampton', dLat: 0.004, dLng: 0.003 },
  { first: 'Gurpreet', last: 'Sandhu', status: B, online: true, vehicle: VehicleType.CAR, docs: 'all', bg: 'CLEAR', zone: 'Bramalea', dLat: -0.003, dLng: 0.004 },
  { first: 'Jasmine', last: 'Dhillon', status: B, online: true, vehicle: VehicleType.CAR, docs: 'all', bg: 'CLEAR', zone: 'Springdale', dLat: 0.002, dLng: -0.004 },
  { first: 'Tariq', last: 'Mahmood', status: B, online: true, vehicle: VehicleType.CAR, docs: 'all', bg: 'CLEAR', zone: 'Heart Lake', dLat: -0.002, dLng: 0.002 },
  { first: 'Amrit', last: 'Sidhu', status: B, online: true, vehicle: VehicleType.E_BIKE, docs: 'all', bg: 'CLEAR', zone: 'Downtown Brampton', dLat: -0.002, dLng: -0.003 },
  { first: 'Kevin', last: 'Brar', status: B, online: true, vehicle: VehicleType.SCOOTER, docs: 'all', bg: 'CLEAR', zone: 'Bramalea', dLat: 0.003, dLng: -0.002 },
  { first: 'Sara', last: 'Ahmed', status: B, online: true, vehicle: VehicleType.CAR, docs: 'all', bg: 'CLEAR', zone: 'Erin Mills', dLat: 0.003, dLng: 0.003 },
  { first: 'Diego', last: 'Alvarez', status: B, online: true, vehicle: VehicleType.CAR, docs: 'all', bg: 'CLEAR', zone: 'City Centre', dLat: -0.002, dLng: 0.004 },
  { first: 'Hannah', last: 'Cooper', status: B, online: true, vehicle: VehicleType.CAR, docs: 'all', bg: 'CLEAR', zone: 'Streetsville', dLat: 0.002, dLng: 0.002 },
  { first: 'Mohammed', last: 'Yusuf', status: B, online: true, vehicle: VehicleType.CAR, docs: 'all', bg: 'CLEAR', zone: 'Meadowvale', dLat: -0.003, dLng: -0.002 },
  { first: 'Nina', last: 'Kowalski', status: B, online: true, vehicle: VehicleType.BIKE, docs: 'all', bg: 'CLEAR', zone: 'Port Credit', dLat: 0.002, dLng: -0.003 },
  { first: 'Rajveer', last: 'Chahal', status: B, vehicle: VehicleType.CAR, docs: 'all', bg: 'CLEAR', zone: 'Bramalea', dLat: 0.001, dLng: 0.001 },
  { first: 'Simran', last: 'Kaur', status: DriverStatus.APPROVED, vehicle: VehicleType.CAR, docs: 'all', bg: 'CLEAR', zone: 'Downtown Brampton', dLat: 0, dLng: 0 },
  { first: 'Andre', last: 'Silva', status: DriverStatus.BACKGROUND_CHECK, vehicle: VehicleType.CAR, docs: 'all', bg: 'IN_PROGRESS', zone: 'Port Credit', dLat: 0, dLng: 0 },
];

/** Adds driver15..28 across Mississauga + Brampton. Idempotent by email; runs after the orders seed so historical orders are unchanged. */
export async function seedDriversExtra(ds: DataSource, opts: SeedOptions): Promise<void> {
  if (!opts.demo) return;
  const users = ds.getRepository(User);
  const profiles = ds.getRepository(DriverProfile);
  const docsRepo = ds.getRepository(DriverDocument);
  const zoneRows = await ds.getRepository(Zone).find({ where: { active: true } });
  const zoneByName = new Map(zoneRows.map((z) => [z.name, z]));
  const hash = await bcrypt.hash(opts.demoPassword, 10);
  const inFuture = (days: number) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  let created = 0;

  for (const [i, p] of EXTRA_PLANS.entries()) {
    const n = PLANS.length + 1 + i; // 15..28
    const email = `driver${n}@demo.forky.ca`;
    if (await users.findOne({ where: { email } })) continue;
    const zone = zoneByName.get(p.zone);
    if (!zone) {
      console.log(`  ! driver ${email}: zone ${p.zone} missing - skipped`);
      continue;
    }
    const sameCity = zoneRows.filter((z) => z.cityId === zone.cityId);
    const zoneIds = [zone.id, ...sameCity.filter((z) => z.id !== zone.id).slice(0, 2).map((z) => z.id)];
    const live = p.status === DriverStatus.ACTIVE;
    const assigned = [DriverStatus.ACTIVE, DriverStatus.APPROVED].includes(p.status);
    const user = await users.save(
      users.create({ type: UserType.DRIVER, status: UserStatus.ACTIVE, email, phone: `+1416555${String(100 + n).padStart(4, '0')}`, emailVerified: true, phoneVerified: true, firstName: p.first, lastName: p.last, passwordHash: hash }),
    );
    const prof = await profiles.save(
      profiles.create({
        userId: user.id,
        cityId: zone.cityId,
        status: p.status,
        statusReason: null,
        vehicleType: p.vehicle,
        vehicleMake: p.vehicle === VehicleType.CAR ? ['Honda', 'Toyota', 'Hyundai', 'Kia'][n % 4] : null,
        vehicleModel: p.vehicle === VehicleType.CAR ? ['Civic', 'Corolla', 'Elantra', 'Forte'][n % 4] : null,
        vehicleColor: ['Black', 'White', 'Silver', 'Blue'][n % 4],
        licensePlate: p.vehicle === VehicleType.CAR ? `CMBR ${100 + n}` : null,
        zoneIds: assigned ? zoneIds : [],
        activeZoneId: p.online ? zone.id : null,
        isOnline: !!p.online,
        onTrip: false,
        wentOnlineAt: p.online ? new Date() : null,
        lat: live ? +(zone.centerLat + p.dLat).toFixed(6) : null,
        lng: live ? +(zone.centerLng + p.dLng).toFixed(6) : null,
        lastLocationAt: live ? new Date() : null,
        backgroundCheckProvider: 'certn-mock',
        backgroundCheckStatus: p.bg,
        backgroundCheckRef: `mock_seed_${n}`,
        trainingCompleted: assigned,
        trainingScore: assigned ? 90 : null,
        insulatedBagConfirmed: assigned,
        welcomeBoostSent: live,
        approvedAt: assigned ? new Date(Date.now() - (20 + n) * 86400000) : null,
        verificationStatus: assigned ? VerificationStatus.VERIFIED : VerificationStatus.PENDING,
        verificationMethod: assigned ? VerificationMethod.MANUAL : null,
        verifiedAt: assigned ? new Date(Date.now() - (20 + n) * 86400000) : null,
        bank: assigned ? { institution: '004', transit: '12345', accountLast4: String(1000 + n), holder: `${p.first} ${p.last}` } : null,
        taxInfo: assigned ? { sinLast3: String(100 + n), legalName: `${p.first} ${p.last}`, address: `${n} Main St, Brampton, ON`, collectedAt: new Date().toISOString() } : null,
        ontarioPlatformWorkerNoticeAcked: true,
        rating: live ? 4.5 + (n % 5) / 10 : 5,
        ratingCount: live ? 10 + n * 3 : 0,
        totalTrips: live ? 30 + n * 9 : 0,
        meta: assigned ? { insurance: { coversDelivery: true, expiresAt: inFuture(200), confirmedAt: new Date().toISOString() } } : {},
      }),
    );
    for (const type of DOC_TYPES) {
      const needsExpiry = [DriverDocType.LICENCE, DriverDocType.INSURANCE, DriverDocType.VEHICLE_REGISTRATION].includes(type);
      await docsRepo.save(
        docsRepo.create({
          driverId: prof.id,
          type,
          fileUrl: `/uploads/demo/driver${n}-${type.toLowerCase()}.jpg`,
          fileName: `${type.toLowerCase()}.jpg`,
          status: DocStatus.APPROVED,
          expiresAt: needsExpiry ? inFuture(180 + n * 10) : null,
          reviewedAt: new Date(),
        }),
      );
    }
    created++;
  }
  if (created) console.log(`  + ${created} extra demo drivers (Brampton + Mississauga)`);
}

/**
 * Rolling-14-day acceptance history for the ACTIVE demo drivers. Inserts realistic ACCEPTED/DECLINED/EXPIRED `driver_offers`
 * rows (referencing existing demo orders) and stores the resulting stats on the profile using the exact AcceptanceService formula
 * (defaults: 14 days, expired counts, min 5 offers, prior 90). Idempotent: drivers flagged `meta.acceptanceSeeded` are skipped.
 * Also adds 1-2 offers older than the window per driver, which must NOT count (proves the rolling window).
 */
export async function seedDriverOfferHistory(ds: DataSource, opts: SeedOptions): Promise<void> {
  if (!opts.demo) return;
  const profiles = ds.getRepository(DriverProfile);
  const drivers = await profiles.find({ where: { status: DriverStatus.ACTIVE }, order: { createdAt: 'ASC' } });
  const orderRows: { id: string }[] = await ds.query(`SELECT id FROM orders ORDER BY "createdAt" DESC LIMIT 200`);
  if (!drivers.length || !orderRows.length) return;
  // target acceptance mix, cycled over the active drivers: a few 95%+, some ~70-85%, some low
  const TARGETS = [97, 94, 72, 88, 55, 100, 78, 42, 91, 68, 96, 83, 60, 99];
  const reasons = ['Too far', 'Not enough pay', 'Busy', 'Order too large'];
  const rnd = (seed: number) => {
    let x = seed;
    return () => ((x = (x * 1664525 + 1013904223) % 4294967296) / 4294967296);
  };
  const cfg = { countExpired: true, minOffers: 5, prior: 90 };
  let done = 0;
  for (const [i, d] of drivers.entries()) {
    if (d.meta?.acceptanceSeeded) continue;
    const r = rnd(1000 + i * 37);
    const target = TARGETS[i % TARGETS.length];
    const total = 8 + Math.floor(r() * 17); // 8..24 offers
    const accepted = Math.round((target / 100) * total);
    const rows: Partial<DriverOffer>[] = [];
    for (let k = 0; k < total; k++) {
      const ageMs = (0.3 + r() * 12.7) * 86400000; // inside the last 13 days
      const sentAt = new Date(Date.now() - ageMs);
      const isAccepted = k < accepted;
      const expired = !isAccepted && r() < 0.3;
      const respondSec = expired ? 30 : 4 + Math.floor(r() * 22);
      rows.push({
        orderId: orderRows[Math.floor(r() * orderRows.length)].id,
        driverId: d.id,
        status: isAccepted ? OfferStatus.ACCEPTED : expired ? OfferStatus.EXPIRED : OfferStatus.DECLINED,
        sequence: 1 + Math.floor(r() * 3),
        round: 0,
        sentAt,
        expiresAt: new Date(sentAt.getTime() + 30_000),
        respondedAt: new Date(sentAt.getTime() + respondSec * 1000),
        pickupDistanceKm: +(0.6 + r() * 3).toFixed(2),
        dropoffDistanceKm: +(1 + r() * 5).toFixed(2),
        estimatedPay: +(4.5 + r() * 6).toFixed(2),
        boostAmount: 0,
        declineReason: isAccepted || expired ? null : reasons[Math.floor(r() * reasons.length)],
      });
    }
    // outside the window: must be ignored by the rolling score
    for (let k = 0; k < 2; k++) {
      const sentAt = new Date(Date.now() - (16 + k * 6 + r() * 3) * 86400000);
      rows.push({
        orderId: orderRows[Math.floor(r() * orderRows.length)].id,
        driverId: d.id,
        status: OfferStatus.DECLINED,
        sequence: 1,
        round: 0,
        sentAt,
        expiresAt: new Date(sentAt.getTime() + 30_000),
        respondedAt: new Date(sentAt.getTime() + 9000),
        estimatedPay: 6,
        boostAmount: 0,
        declineReason: 'Busy',
      });
    }
    await ds.getRepository(DriverOffer).insert(rows as any);
    const inWin = rows.slice(0, total);
    const nAcc = inWin.filter((o) => o.status === OfferStatus.ACCEPTED).length;
    const nDec = inWin.filter((o) => o.status === OfferStatus.DECLINED).length;
    const nExp = inWin.filter((o) => o.status === OfferStatus.EXPIRED).length;
    const counted = nAcc + nDec + (cfg.countExpired ? nExp : 0);
    const raw = counted ? (nAcc / counted) * 100 : cfg.prior;
    const w = counted >= cfg.minOffers ? 1 : counted / cfg.minOffers;
    const rate = counted ? Math.round((w * raw + (1 - w) * cfg.prior) * 100) / 100 : cfg.prior;
    await profiles.update(d.id, {
      acceptanceRate: rate,
      offersAccepted14d: nAcc,
      offersDeclined14d: nDec,
      offersExpired14d: nExp,
      offersTotal14d: nAcc + nDec + nExp,
      acceptanceUpdatedAt: new Date(),
      meta: { ...(d.meta ?? {}), acceptanceSeeded: true } as any,
    });
    done++;
  }
  if (done) console.log(`  + acceptance history (rolling 14d) for ${done} active drivers`);
}
