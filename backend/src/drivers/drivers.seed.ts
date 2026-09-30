import { DataSource } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { City, DriverDocument, DriverProfile, TrainingModule, User, Zone } from '../database/entities';
import { DocStatus, DriverDocType, DriverStatus, UserStatus, UserType, VehicleType } from '../common/enums';
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
    const email = `driver${n}@demo.forksy.ca`;
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
