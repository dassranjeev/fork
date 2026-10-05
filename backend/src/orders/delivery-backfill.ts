import { DataSource } from 'typeorm';
import { Address, User } from '../database/entities';
import { sealCode } from './delivery-instructions';

/**
 * Idempotent, additive data steps for the delivery-instructions feature (safe to run on every boot and from the seed runner):
 *  1. history: orders flagged contactless get dropoffMethod LEAVE_AT_DOOR (everything else keeps the HAND_TO_ME default);
 *  2. demo customers 1..10 get saved addresses with default handoff method / instructions / access code (logins untouched).
 */
export async function backfillDeliveryInstructions(ds: DataSource, opts: { demo: boolean }): Promise<void> {
  await ds.query(`UPDATE orders SET "dropoffMethod" = 'LEAVE_AT_DOOR' WHERE contactless = true AND "dropoffMethod" = 'HAND_TO_ME'`);
  if (!opts.demo) return;
  const users = ds.getRepository(User);
  const addrs = ds.getRepository(Address);
  const SAMPLES = [
    { label: 'Home (demo)', method: 'HAND_TO_ME', notes: 'Ring the doorbell twice. Unit 5, use side door.', code: null, dLat: 0.0012, dLng: 0.001 },
    { label: 'Condo (demo)', method: 'LEAVE_AT_DOOR', notes: "Leave with the concierge. Don't ring the bell - sleeping baby.", code: '#4821', dLat: -0.001, dLng: 0.0014 },
    { label: 'Office (demo)', method: 'MEET_OUTSIDE', notes: 'Call on arrival, I will meet you at the lobby entrance.', code: null, dLat: 0.0018, dLng: -0.001 },
  ];
  for (let n = 1; n <= 10; n++) {
    const u = await users.findOne({ where: { email: `customer${n}@demo.forksy.ca` } });
    if (!u) continue;
    const base = await addrs.findOne({ where: { customerId: u.id }, order: { createdAt: 'ASC' } });
    if (!base || base.lat == null || base.lng == null) continue;
    for (const [i, s] of SAMPLES.entries()) {
      if (i === 2 && n % 2) continue; // not everyone has all three
      if (await addrs.exist({ where: { customerId: u.id, label: s.label } })) continue;
      await addrs.insert({
        customerId: u.id,
        label: s.label,
        line1: `${base.line1} (${s.label.split(' ')[0]})`,
        line2: i === 0 ? 'Unit 5' : null,
        city: base.city,
        province: base.province,
        postalCode: base.postalCode,
        lat: base.lat + s.dLat,
        lng: base.lng + s.dLng,
        dropoffMethod: s.method,
        dropoffNotes: s.notes,
        accessCode: sealCode(s.code),
        isDefault: false,
      });
    }
  }
}
