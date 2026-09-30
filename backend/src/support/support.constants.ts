import { TicketCategory, TicketStatus, TicketTier } from '../common/enums';

export type Requester = 'CUSTOMER' | 'RESTAURANT' | 'DRIVER' | 'STAFF';
export type Priority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
export type ChargedTo = 'RESTAURANT' | 'PLATFORM' | 'DRIVER';

export const PRIORITIES: Priority[] = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
export const PRIORITY_WEIGHT: Record<Priority, number> = { LOW: 1, NORMAL: 2, HIGH: 3, URGENT: 4 };
/** SLA multipliers: urgent tickets get a quarter of the normal time. */
export const SLA_FACTOR: Record<Priority, number> = { URGENT: 0.25, HIGH: 0.5, NORMAL: 1, LOW: 2 };

export const OPEN_STATUSES = [TicketStatus.OPEN, TicketStatus.PENDING, TicketStatus.ESCALATED];

/** Ticket state machine (SOP-06). RESOLVED needs reasonCode + chargedTo. */
export const TICKET_TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  [TicketStatus.OPEN]: [TicketStatus.PENDING, TicketStatus.ESCALATED, TicketStatus.RESOLVED],
  [TicketStatus.PENDING]: [TicketStatus.OPEN, TicketStatus.ESCALATED, TicketStatus.RESOLVED],
  [TicketStatus.ESCALATED]: [TicketStatus.OPEN, TicketStatus.PENDING, TicketStatus.RESOLVED],
  [TicketStatus.RESOLVED]: [TicketStatus.CLOSED, TicketStatus.OPEN],
  [TicketStatus.CLOSED]: [TicketStatus.OPEN],
};

/** Reason codes for the resolve dialog (SOP-06 step 3). */
export const REASON_CODES: { code: string; label: string; category?: TicketCategory }[] = [
  { code: 'MISSING_ITEM', label: 'Missing item', category: TicketCategory.MISSING_ITEM },
  { code: 'WRONG_ITEM', label: 'Wrong item', category: TicketCategory.WRONG_ITEM },
  { code: 'NEVER_ARRIVED', label: 'Order never arrived', category: TicketCategory.NEVER_ARRIVED },
  { code: 'LATE', label: 'Very late delivery', category: TicketCategory.VERY_LATE },
  { code: 'QUALITY', label: 'Food quality', category: TicketCategory.FOOD_QUALITY },
  { code: 'RESTAURANT_CANCELLED', label: 'Restaurant cancelled after accept', category: TicketCategory.RESTAURANT_CANCELLED },
  { code: 'PAYMENT_ISSUE', label: 'Payment issue', category: TicketCategory.PAYMENT },
  { code: 'PAYOUT_ISSUE', label: 'Payout issue', category: TicketCategory.PAYOUT },
  { code: 'ACCOUNT_HELP', label: 'Account help', category: TicketCategory.ACCOUNT },
  { code: 'SAFETY', label: 'Safety concern', category: TicketCategory.SAFETY },
  { code: 'EVIDENCE_CONTRADICTS', label: 'Evidence contradicts claim (no refund)' },
  { code: 'INFO_PROVIDED', label: 'Information provided' },
  { code: 'GOODWILL', label: 'Goodwill gesture' },
  { code: 'DUPLICATE', label: 'Duplicate ticket' },
  { code: 'NO_RESPONSE', label: 'No response from requester' },
];

/** Default tier for a category when nothing else escalates it (spec 9.2). */
export function defaultTier(category: TicketCategory): TicketTier {
  switch (category) {
    case TicketCategory.SAFETY:
      return TicketTier.TIER2;
    case TicketCategory.PAYOUT:
      return TicketTier.FINANCE;
    default:
      return TicketTier.TIER1;
  }
}

/** Tags that force a tier (chargebacks/payout disputes/commission corrections -> FINANCE; fraud/disputes/bans -> TIER2). */
export const FINANCE_TAGS = ['chargeback', 'payout_dispute', 'commission_correction', 'commission'];
export const TIER2_TAGS = ['fraud', 'dispute', 'ban', 'account_ban', 'refund_over_limit', 'legal'];

export interface RouteInput {
  category: TicketCategory;
  requesterType: Requester;
  tags?: string[];
  subject?: string;
  flaggedAccount?: boolean;
  requestedTier?: TicketTier;
}

/** Escalation routing on create / retag. Returns tier + reason when it is not plain TIER1. */
export function routeTier(i: RouteInput): { tier: TicketTier; reason: string | null } {
  const tags = (i.tags ?? []).map((t) => t.toLowerCase());
  const text = `${i.subject ?? ''}`.toLowerCase();
  if (tags.some((t) => FINANCE_TAGS.includes(t)) || /chargeback|commission correction|payout dispute/.test(text)) {
    return { tier: TicketTier.FINANCE, reason: 'Chargeback / payout dispute / commission correction -> Finance' };
  }
  if (i.category === TicketCategory.PAYOUT) return { tier: TicketTier.FINANCE, reason: 'Payout issue -> Finance' };
  if (tags.some((t) => TIER2_TAGS.includes(t))) return { tier: TicketTier.TIER2, reason: 'Fraud / dispute / ban -> Tier 2' };
  if (i.category === TicketCategory.SAFETY) return { tier: TicketTier.TIER2, reason: 'Safety complaint -> Tier 2' };
  if (i.flaggedAccount) return { tier: TicketTier.TIER2, reason: 'Flagged account -> Tier 2' };
  if (i.requestedTier && i.requestedTier !== TicketTier.SELF_SERVE) return { tier: i.requestedTier, reason: null };
  return { tier: TicketTier.TIER1, reason: null };
}

export function defaultPriority(category: TicketCategory, tier: TicketTier): Priority {
  if (category === TicketCategory.SAFETY) return 'URGENT';
  if (category === TicketCategory.NEVER_ARRIVED || category === TicketCategory.VERY_LATE || category === TicketCategory.RESTAURANT_CANCELLED) return 'HIGH';
  if (tier === TicketTier.TIER2 || tier === TicketTier.FINANCE) return 'HIGH';
  return 'NORMAL';
}

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Customer-facing issue types for the self-serve report flow. */
export const CUSTOMER_ISSUE_TYPES: {
  category: TicketCategory;
  label: string;
  labelFr: string;
  needsItems: boolean;
  needsPhoto: boolean;
  when: 'AFTER_DELIVERY' | 'ANY_ACTIVE_OR_DELIVERED' | 'CANCELLED';
}[] = [
  { category: TicketCategory.MISSING_ITEM, label: 'An item is missing', labelFr: 'Un article est manquant', needsItems: true, needsPhoto: false, when: 'AFTER_DELIVERY' },
  { category: TicketCategory.WRONG_ITEM, label: 'I received the wrong item', labelFr: 'Mauvais article recu', needsItems: true, needsPhoto: true, when: 'AFTER_DELIVERY' },
  { category: TicketCategory.NEVER_ARRIVED, label: 'My order never arrived', labelFr: 'Ma commande nest pas arrivee', needsItems: false, needsPhoto: false, when: 'ANY_ACTIVE_OR_DELIVERED' },
  { category: TicketCategory.VERY_LATE, label: 'My order was very late', labelFr: 'Ma commande etait tres en retard', needsItems: false, needsPhoto: false, when: 'ANY_ACTIVE_OR_DELIVERED' },
  { category: TicketCategory.FOOD_QUALITY, label: 'Food quality problem', labelFr: 'Probleme de qualite', needsItems: true, needsPhoto: true, when: 'AFTER_DELIVERY' },
  { category: TicketCategory.RESTAURANT_CANCELLED, label: 'Restaurant cancelled my order', labelFr: 'Le restaurant a annule ma commande', needsItems: false, needsPhoto: false, when: 'CANCELLED' },
  { category: TicketCategory.PAYMENT, label: 'Payment or charge problem', labelFr: 'Probleme de paiement', needsItems: false, needsPhoto: false, when: 'ANY_ACTIVE_OR_DELIVERED' },
  { category: TicketCategory.SAFETY, label: 'Safety concern', labelFr: 'Probleme de securite', needsItems: false, needsPhoto: false, when: 'ANY_ACTIVE_OR_DELIVERED' },
  { category: TicketCategory.OTHER, label: 'Something else', labelFr: 'Autre chose', needsItems: false, needsPhoto: false, when: 'ANY_ACTIVE_OR_DELIVERED' },
];

/** Ontario-compliant plain-language auto messages (EN / FR). Always offer a human. */
export const AUTO_MESSAGES = {
  en: {
    credit: (amount: string, code: string, why: string) =>
      `We are sorry about order ${code}. ${why} We added ${amount} in FORKSY credit to your wallet right away; it is yours to use on any order. This was decided automatically based on our refund policy. If you would like a person to look at it again, just reply to this ticket or tap "Talk to a person" and an agent will review it.`,
    refund: (amount: string, code: string, why: string) =>
      `We are sorry about order ${code}. ${why} We are refunding ${amount} to your original payment method; banks usually post it within 5 to 10 business days. This was decided automatically based on our refund policy. You can ask a person to review it at any time by replying to this ticket.`,
    both: (refund: string, credit: string, code: string, why: string) =>
      `We are sorry order ${code} was late. ${why} We are refunding ${refund} (your delivery fee, to your original payment method, usually 5 to 10 business days) and added ${credit} in FORKSY credit to your wallet now. This was decided automatically. Reply any time to have a person review it.`,
    review: (code: string) =>
      `Thanks for letting us know about order ${code}. A support agent is reviewing the details (order timeline, delivery location and photos) and will reply as soon as possible. You do not need to do anything else; you can add photos or details by replying here.`,
    evidenceReview: (code: string) =>
      `Thanks for reporting order ${code}. Our records for this order need a closer look by a person, so an agent will review it and reply. No action is needed from you; you can add details or photos by replying here.`,
    resolvedNotice: (num: string) => `Your ticket ${num} was resolved. Please confirm it worked out or reply if you still need help; you can rate our support too.`,
  },
  fr: {
    credit: (amount: string, code: string, why: string) =>
      `Nous sommes desoles pour la commande ${code}. ${why} Nous avons ajoute ${amount} de credit FORKSY a votre portefeuille immediatement. Cette decision a ete prise automatiquement selon notre politique de remboursement. Pour qu'une personne revoie votre dossier, repondez simplement a ce billet.`,
    refund: (amount: string, code: string, why: string) =>
      `Nous sommes desoles pour la commande ${code}. ${why} Nous remboursons ${amount} sur votre mode de paiement d'origine; comptez habituellement de 5 a 10 jours ouvrables. Decision automatique; repondez a ce billet pour demander une revision par une personne.`,
    both: (refund: string, credit: string, code: string, why: string) =>
      `Nous sommes desoles du retard de la commande ${code}. ${why} Nous remboursons ${refund} (frais de livraison, sur votre mode de paiement d'origine, de 5 a 10 jours ouvrables) et avons ajoute ${credit} de credit FORKSY. Decision automatique; repondez pour une revision par une personne.`,
    review: (code: string) =>
      `Merci de nous avoir signale un probleme avec la commande ${code}. Un agent examine les details et vous repondra rapidement. Vous pouvez ajouter des photos ou des precisions en repondant ici.`,
    evidenceReview: (code: string) =>
      `Merci d'avoir signale la commande ${code}. Un agent doit examiner ce dossier de plus pres et vous repondra. Vous pouvez ajouter des precisions en repondant ici.`,
    resolvedNotice: (num: string) => `Votre billet ${num} a ete regle. Confirmez que tout est en ordre ou repondez si vous avez encore besoin d'aide.`,
  },
};
