import { BadRequestException } from '@nestjs/common';
import { DropoffMethod } from '../common/enums';
import { seal, unseal } from '../common/secretbox';

export const ACCESS_CODE_RE = /^[A-Za-z0-9 #*\-_./]{1,40}$/;

/** Plain-text delivery instructions: tags/control chars removed, whitespace collapsed, max 300. */
export function cleanNotes(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.length > 300) throw new BadRequestException('Delivery instructions can be at most 300 characters');
  return s || null;
}

export function cleanAccessCode(v: unknown): string | null {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (!ACCESS_CODE_RE.test(s)) throw new BadRequestException('Access code can be at most 40 characters (letters, digits, space and # * - _ . /)');
  return s;
}

export const sealCode = (c: string | null): string | null => (c ? seal(c) : null);
export const openCode = (c: string | null | undefined): string | null => {
  if (!c) return null;
  try { return unseal(c); } catch { return null; }
};
export const maskCode = (c: string | null | undefined) => (c ? '\u2022\u2022\u2022\u2022' : null);

export function methodFromLegacy(contactless?: boolean, method?: string | null): DropoffMethod {
  if (method) return method as DropoffMethod;
  return contactless ? DropoffMethod.LEAVE_AT_DOOR : DropoffMethod.HAND_TO_ME;
}

/** GET /public/delivery-options */
export const DELIVERY_OPTIONS = {
  methods: [
    { value: DropoffMethod.HAND_TO_ME, label: 'Hand it to me', description: 'The driver brings the order to you and hands it over.', contactless: false, proof: { type: 'PIN', summary: 'You get a 4-digit PIN. Tell it to the driver when you receive the order.' } },
    { value: DropoffMethod.MEET_OUTSIDE, label: 'Meet outside', description: 'You meet the driver outside the building or at the curb.', contactless: false, proof: { type: 'PIN', summary: 'You get a 4-digit PIN. Tell it to the driver when you meet.' } },
    { value: DropoffMethod.LEAVE_AT_DOOR, label: 'Leave at my door', description: 'Contactless: the driver leaves the order at your door and takes a photo.', contactless: true, proof: { type: 'PHOTO', summary: 'No PIN needed. The driver takes a photo of the order at your door; you can see it in the app.' } },
  ],
  suggestedInstructions: ['Ring doorbell', "Don't ring the bell - sleeping baby", 'Call on arrival', 'Beware of dog', 'Leave with the concierge', 'Use the side door', 'Knock softly', 'Text me when you arrive'],
  limits: { dropoffNotesMax: 300, accessCodeMax: 40 },
  notes: 'Delivery instructions go to your driver only. Notes for the kitchen are separate ("kitchen notes").',
};
