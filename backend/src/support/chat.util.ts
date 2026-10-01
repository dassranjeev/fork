import { BadRequestException } from '@nestjs/common';

export const CHAT_MAX_BODY = 2000;
export const CHAT_MAX_ATTACHMENTS = 3;
const IMAGE_EXT = /\.(jpe?g|png|webp|gif|heic)$/i;

/** Strip HTML tags and control characters; clients must still render the text as plain text. */
export function cleanChatText(s: string | undefined | null): string {
  return (s ?? '')
    .replace(/<\/?[a-z!][^>]*>/gi, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\r\n/g, '\n')
    .trim();
}

/** Body + attachment validation shared by all send paths. Attachments must be images uploaded through POST /uploads. */
export function prepareChatMessage(body: string | undefined, attachments: string[] | undefined, publicUrl: string) {
  const text = cleanChatText(body);
  if (text.length > CHAT_MAX_BODY) throw new BadRequestException(`Message too long (max ${CHAT_MAX_BODY} characters)`);
  const files = (attachments ?? []).filter((a) => typeof a === 'string');
  if (files.length > CHAT_MAX_ATTACHMENTS) throw new BadRequestException(`At most ${CHAT_MAX_ATTACHMENTS} attachments per message`);
  const prefix = `${publicUrl.replace(/\/$/, '')}/uploads/`;
  for (const f of files) {
    if (!f.startsWith(prefix) || f.length > 500 || !IMAGE_EXT.test(f.split('?')[0])) {
      throw new BadRequestException('Attachments must be image files (jpg, png, webp, gif, heic) uploaded via POST /uploads');
    }
  }
  if (!text && !files.length) throw new BadRequestException('Message is empty');
  return { text, files };
}

export interface ChatHours {
  timezone?: string;
  days?: number[];
  start?: string;
  end?: string;
}

const toMin = (hhmm: string | undefined, dflt: number) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm ?? '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : dflt;
};

/** Is `now` inside the configured live chat hours (setting `support.chat.hours`)? */
export function withinChatHours(h: ChatHours | null | undefined, now = new Date()): boolean {
  if (!h || typeof h !== 'object') return true;
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: h.timezone || 'America/Toronto', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
    const minutes = Number(get('hour')) * 60 + Number(get('minute'));
    if (h.days && !h.days.includes(day)) return false;
    return minutes >= toMin(h.start, 0) && minutes < toMin(h.end, 1440);
  } catch {
    return true;
  }
}

export const CHAT_TOPICS: { code: string; label: string; audience: ('CUSTOMER' | 'DRIVER')[] }[] = [
  { code: 'MISSING_ITEM', label: 'Missing item', audience: ['CUSTOMER'] },
  { code: 'WRONG_ITEM', label: 'Wrong item', audience: ['CUSTOMER'] },
  { code: 'NEVER_ARRIVED', label: 'Order never arrived', audience: ['CUSTOMER', 'DRIVER'] },
  { code: 'VERY_LATE', label: 'Order very late', audience: ['CUSTOMER', 'DRIVER'] },
  { code: 'FOOD_QUALITY', label: 'Food quality', audience: ['CUSTOMER'] },
  { code: 'RESTAURANT_CANCELLED', label: 'Restaurant cancelled', audience: ['CUSTOMER', 'DRIVER'] },
  { code: 'PAYMENT', label: 'Payment or charge', audience: ['CUSTOMER'] },
  { code: 'PAYOUT', label: 'Earnings or payout', audience: ['DRIVER'] },
  { code: 'ACCOUNT', label: 'Account help', audience: ['CUSTOMER', 'DRIVER'] },
  { code: 'SAFETY', label: 'Safety concern', audience: ['CUSTOMER', 'DRIVER'] },
  { code: 'OTHER', label: 'Something else', audience: ['CUSTOMER', 'DRIVER'] },
];

export const maskPhone = (p?: string | null) => (p ? `${p.slice(0, 2)}${'*'.repeat(Math.max(0, p.length - 6))}${p.slice(-4)}` : null);
export const fullName = (u?: { firstName?: string | null; lastName?: string | null; email?: string | null } | null) => (u ? `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || u.email || 'User' : 'User');
