import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { UserType, VerificationAudience, VerificationMethod } from '../common/enums';

/**
 * Registration and verification policy (docs/verification.md). Pure helpers with no module dependencies, so the auth layer, the
 * settings service and the unit tests can all use them.
 *
 * Per audience (drivers, businesses) the Super Admin chooses two things:
 *   - instant registration: ON = a new account is active at once, with no verification step (it is recorded as UNVERIFIED);
 *   - verification method: MANUAL (staff review) or AUTOMATIC (Certn background check). It is what a new sign-up goes through when
 *     instant registration is OFF, and what "Force verification" puts unverified accounts through.
 */

export type VerificationChoice = VerificationMethod.MANUAL | VerificationMethod.AUTOMATIC;

export interface VerificationPolicy {
  audience: VerificationAudience;
  instant: boolean;
  method: VerificationChoice;
  /** what a NEW sign-up goes through right now: INSTANT when instant registration is on, otherwise the method */
  mode: VerificationMethod;
}

/** The settings that hold the policy (group "verification": never listed on the generic Settings page, edited on System > Verification). */
export const POLICY_KEYS: Record<VerificationAudience, { instant: string; method: string }> = {
  [VerificationAudience.DRIVER]: { instant: 'verification.drivers.instant', method: 'verification.drivers.method' },
  [VerificationAudience.BUSINESS]: { instant: 'verification.businesses.instant', method: 'verification.businesses.method' },
};

export const VERIFICATION_SETTING_GROUP = 'verification';
/** internal flag: the one-time backfill of existing accounts has run (see verification-backfill.ts) */
export const BACKFILL_KEY = 'verification.backfilled';

export const VERIFICATION_SETTING_DEFINITIONS = [
  {
    key: POLICY_KEYS.DRIVER.instant,
    group: VERIFICATION_SETTING_GROUP,
    label: 'Drivers: instant registration (a new driver is active at once with no verification step; recorded as unverified)',
    value: false,
    inputType: 'boolean',
  },
  {
    key: POLICY_KEYS.DRIVER.method,
    group: VERIFICATION_SETTING_GROUP,
    label: 'Drivers: verification method (MANUAL = staff review, AUTOMATIC = Certn background check)',
    value: VerificationMethod.MANUAL,
    inputType: 'select',
  },
  {
    key: POLICY_KEYS.BUSINESS.instant,
    group: VERIFICATION_SETTING_GROUP,
    label: 'Businesses: instant registration (a new business is live at once with no verification step; recorded as unverified)',
    value: false,
    inputType: 'boolean',
  },
  {
    key: POLICY_KEYS.BUSINESS.method,
    group: VERIFICATION_SETTING_GROUP,
    label: 'Businesses: verification method (MANUAL = staff review, AUTOMATIC = Certn background check of the owner)',
    value: VerificationMethod.MANUAL,
    inputType: 'select',
  },
  {
    key: BACKFILL_KEY,
    group: VERIFICATION_SETTING_GROUP,
    label: 'Internal: existing drivers and businesses were recorded as manually verified once (do not change)',
    value: false,
    inputType: 'boolean',
  },
];

interface SettingsReader {
  get<T = any>(key: string, fallback?: T): T;
}

/** Reads the policy of one audience. Tolerant of garbage in the settings table: anything unexpected means "MANUAL, not instant" (the safe default). */
export function readPolicy(settings: SettingsReader, audience: VerificationAudience): VerificationPolicy {
  const keys = POLICY_KEYS[audience];
  const instant = settings.get<unknown>(keys.instant, false) === true;
  const method: VerificationChoice = settings.get<unknown>(keys.method, VerificationMethod.MANUAL) === VerificationMethod.AUTOMATIC ? VerificationMethod.AUTOMATIC : VerificationMethod.MANUAL;
  return { audience, instant, method, mode: instant ? VerificationMethod.INSTANT : method };
}

/** One plain sentence about what the current mode does, shown on the Verification page and in the docs. */
export function describeMode(audience: VerificationAudience, mode: VerificationMethod): string {
  const who = audience === VerificationAudience.DRIVER ? 'driver' : 'business';
  if (mode === VerificationMethod.INSTANT) {
    return audience === VerificationAudience.DRIVER
      ? 'A new driver is active the moment they sign up and can go online straight away. They are recorded as unverified until you force verification.'
      : 'A new business is live the moment it applies and can use the portal and receive orders straight away. It is recorded as unverified until you force verification.';
  }
  if (mode === VerificationMethod.AUTOMATIC) {
    return `A new ${who} is sent a Certn identity and criminal-record check and is activated automatically when it comes back clear. A flagged or failed result goes to staff, who decide; nobody is rejected automatically.`;
  }
  return audience === VerificationAudience.DRIVER
    ? 'A new driver waits for staff to review their documents and background check, then approve and activate them (SOP-02).'
    : 'A new business waits for staff to review its documents, menu and a test order, then go live (SOP-01).';
}

// ------------------------------------------------------------------ Certn readiness
export interface CertnStatus {
  /** an API key is set */
  configured: boolean;
  /** development only: no key, the built-in mock clears every check after a few seconds */
  mock: boolean;
  /** the shared secret that authenticates Certn's result webhook is set */
  webhookSecret: boolean;
  /** where Certn must send results (CERTN_WEBHOOK_URL, else derived from PUBLIC_URL), null when unknown */
  webhookUrl: string | null;
  /** can AUTOMATIC verification work right now? In production it needs the API key AND the webhook secret (without it results are refused and every check would hang) */
  ready: boolean;
  provider: 'certn' | 'certn-mock';
  reason: string | null;
}

export function certnStatus(env: NodeJS.ProcessEnv = process.env): CertnStatus {
  const key = (env.CERTN_API_KEY ?? '').trim();
  const secret = (env.CERTN_WEBHOOK_SECRET ?? '').trim();
  const prod = env.NODE_ENV === 'production';
  const pub = (env.PUBLIC_URL ?? '').trim().replace(/\/+$/, '');
  const webhookUrl = (env.CERTN_WEBHOOK_URL ?? '').trim() || (pub ? `${pub}/api/v1/public/webhooks/certn` : null);
  let reason: string | null = null;
  if (prod && !key) reason = 'Certn is not configured: set CERTN_API_KEY on the server.';
  else if (prod && !secret) reason = 'Certn results cannot be received: set CERTN_WEBHOOK_SECRET on the server (the same secret goes into the Certn webhook settings).';
  return {
    configured: !!key,
    mock: !key && !prod,
    webhookSecret: !!secret,
    webhookUrl,
    ready: reason === null,
    provider: key ? 'certn' : 'certn-mock',
    reason,
  };
}

/**
 * What the verification flow remembers on a driver's `meta.verification` (and on a restaurant's `meta.verification`).
 * `restoreStatus` is the status an account had when Force verification took it off the road; it is put back once the account is verified.
 */
export interface VerificationMeta {
  restoreStatus?: string | null;
  /** restaurants only: was the store accepting orders when it was taken off the road */
  restoreAccepting?: boolean | null;
  blockedAt?: string | null;
  /** staff user who forced the verification (null: the system) */
  forcedBy?: string | null;
  /** automatic method: how often starting the Certn check failed (the sweeper retries a few times, then hands the account to staff) */
  certnAttempts?: number;
  certnError?: string | null;
  /** automatic was chosen but Certn was not usable at that moment, so the sign-up went to manual review instead */
  fallback?: string | null;
  reminderSentAt?: string | null;
  /** drivers: a Super Admin verified the driver despite missing documents, so the documents are not required to go online either */
  docsWaived?: boolean;
}

/** `meta` with the "restore this status later" memory cleared (the account is verified, rejected or approved by hand). */
export function withoutRestore<T extends Record<string, any> | null | undefined>(meta: T): T {
  if (!meta || !meta.verification) return meta;
  return { ...meta, verification: { ...meta.verification, restoreStatus: null, restoreAccepting: null, blockedAt: null } };
}

/** What an app or portal shows about an account's verification: state plus one plain sentence on what happens next. */
export interface VerificationSummary {
  status: string;
  method: string | null;
  dueAt: Date | string | null;
  verifiedAt: Date | string | null;
  nextStep: string | null;
}

export function verificationSummary(
  audience: VerificationAudience,
  s: { verificationStatus: string; verificationMethod: string | null; verificationDueAt: Date | null; verifiedAt: Date | null; backgroundCheckStatus?: string | null },
): VerificationSummary {
  const who = audience === VerificationAudience.DRIVER ? 'account' : 'business';
  const by = s.verificationDueAt ? ` Please finish by ${s.verificationDueAt.toISOString().slice(0, 10)}.` : '';
  let nextStep: string | null = null;
  switch (s.verificationStatus) {
    case 'UNVERIFIED':
      nextStep = `Your ${who} is active but not verified. We may ask you to verify it later.`;
      break;
    case 'PENDING':
      if (s.verificationMethod === VerificationMethod.AUTOMATIC) {
        nextStep =
          s.backgroundCheckStatus === 'IN_PROGRESS'
            ? `Complete the identity and background check Certn emailed you; your ${who} is activated automatically when it clears.${by}`
            : `We are starting your identity and background check with Certn; watch your email for the link.${by}`;
      } else {
        nextStep = `Our team is reviewing your ${audience === VerificationAudience.DRIVER ? 'application' : 'business'}. Upload any documents we ask for.${by}`;
      }
      break;
    case 'NEEDS_REVIEW':
      nextStep = 'Your verification needs a closer look by our team. We will contact you.';
      break;
    case 'REJECTED':
      nextStep = `We could not verify your ${who}.`;
      break;
    default:
      nextStep = null;
  }
  return { status: s.verificationStatus, method: s.verificationMethod, dueAt: s.verificationDueAt, verifiedAt: s.verifiedAt, nextStep };
}

/** " by 2026-11-01" for a deadline that is still ahead, "" when there is none or it is already now. */
export function deadlineText(dueAt: Date | null): string {
  return dueAt && dueAt.getTime() > Date.now() + 60_000 ? ` by ${dueAt.toISOString().slice(0, 10)}` : '';
}

/** Verifying an account whose checklist is incomplete is a Super Admin decision and must say why. */
export function assertOverrideAllowed(actor: { type?: string } | null | undefined, note?: string) {
  if (actor?.type !== UserType.SUPER_ADMIN) throw new ForbiddenException('Only a Super Admin can verify an account whose checklist is incomplete');
  if (!note || note.trim().length < 3) throw new BadRequestException('A note explaining the override is required');
}

/** One plain sentence telling a person what they have to do for the given verification method. */
export function verificationSteps(audience: VerificationAudience, method: VerificationMethod): string {
  if (method === VerificationMethod.AUTOMATIC) return 'Certn will email you a secure link to verify your identity and run a background check. Complete it and your account is activated automatically.';
  return audience === VerificationAudience.DRIVER
    ? 'Open the app and upload your documents (licence, vehicle registration, insurance, photo, work eligibility). Our team will review them.'
    : 'Open the portal and upload your business documents (business licence, health certificate, void cheque). Our team will review them.';
}

/** Limits of the Force verification action. */
export const FORCE_MAX_IDS = 500;
export const FORCE_MAX_GRACE_DAYS = 90;
