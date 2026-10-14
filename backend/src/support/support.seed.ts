import { DataSource } from 'typeorm';
import { SeedOptions } from '../database/seed-types';
import { CannedReply } from '../database/entities';
import { TicketCategory } from '../common/enums';

const CANNED: { shortcut: string; title: string; body: string; category?: TicketCategory; audience?: string }[] = [
  { shortcut: '/hello', title: 'Greeting', body: 'Hi {{customerName}}, this is {{agentName}} from FORKY support. I am looking at ticket {{ticketNumber}} now.' },
  { shortcut: '/late', title: 'Late order apology', category: TicketCategory.VERY_LATE, audience: 'CUSTOMER', body: 'Sorry {{customerName}}, order {{orderCode}} arrived later than promised. We have applied a delivery-fee refund and credit.' },
  { shortcut: '/missing', title: 'Missing item', category: TicketCategory.MISSING_ITEM, audience: 'CUSTOMER', body: 'Sorry about the missing item on order {{orderCode}}. We have credited the item to your wallet.' },
  { shortcut: '/evidence', title: 'Need photo', audience: 'CUSTOMER', body: 'Could you reply with a photo of the issue on order {{orderCode}}? It helps us resolve this quickly.' },
  { shortcut: '/payout', title: 'Payout under review', category: TicketCategory.PAYOUT, audience: 'RESTAURANT', body: 'Thanks for flagging this. Finance is reviewing your payout and will reply on ticket {{ticketNumber}}.' },
  { shortcut: '/resolved', title: 'Resolved', body: 'We believe this is resolved. Please confirm or reply if you still need help. - {{agentName}}' },
];

/** Idempotent: canned replies are foundational data (always seeded). Demo tickets/cases are created through the app flows. */
export async function seedSupport(ds: DataSource, _opts: SeedOptions): Promise<void> {
  const repo = ds.getRepository(CannedReply);
  for (const c of CANNED) {
    if (await repo.findOne({ where: { shortcut: c.shortcut } })) continue;
    await repo.save(repo.create({ ...c, category: c.category ?? null, audience: c.audience ?? 'ANY' }));
  }
}
