import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';

export type BgStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'CLEAR' | 'CONSIDER' | 'FAILED';

export interface BackgroundCheckSubject {
  driverId: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
}

export interface BackgroundCheckResult {
  ref: string;
  status: BgStatus;
  provider: string;
  reportUrl?: string;
}

/** Provider-agnostic interface so another vendor can replace Certn. */
export interface BackgroundCheckProvider {
  readonly name: string;
  /** Kick off a check. Result arrives via webhook (real) or the onResult callback (mock). */
  start(subject: BackgroundCheckSubject, onResult: (r: BackgroundCheckResult) => void): Promise<BackgroundCheckResult>;
  /** Normalise a provider webhook payload. */
  parseWebhook(body: any): BackgroundCheckResult | null;
}

/** Map Certn result words to our status. */
export function mapCertnStatus(raw?: string | null): BgStatus {
  const v = String(raw ?? '').toLowerCase();
  if (['clear', 'cleared', 'complete_clear', 'pass', 'passed'].includes(v)) return 'CLEAR';
  if (['consider', 'review', 'flagged', 'adverse'].includes(v)) return 'CONSIDER';
  if (['failed', 'fail', 'cancelled', 'canceled', 'error', 'rejected'].includes(v)) return 'FAILED';
  return 'IN_PROGRESS';
}

/**
 * Certn adapter (https://certn.co). Real HTTP when CERTN_API_KEY is set (CERTN_API_URL overrides the base URL);
 * otherwise a mock provider that returns CLEAR after CERTN_MOCK_DELAY_MS (default 4 s).
 * The mock returns CONSIDER when the driver email contains "+consider" (handy for testing).
 */
@Injectable()
export class CertnAdapter implements BackgroundCheckProvider {
  private readonly logger = new Logger('Certn');

  get name() {
    return process.env.CERTN_API_KEY ? 'certn' : 'certn-mock';
  }

  async start(s: BackgroundCheckSubject, onResult: (r: BackgroundCheckResult) => void): Promise<BackgroundCheckResult> {
    const key = process.env.CERTN_API_KEY;
    if (!key) return this.mockStart(s, onResult);
    const base = process.env.CERTN_API_URL ?? 'https://api.certn.co';
    const res = await fetch(`${base}/hrpm/api/v1/applications/invite/`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: s.email,
        first_name: s.firstName,
        last_name: s.lastName,
        phone_number: s.phone,
        request_criminal_record_check: true,
        request_identity_verification: true,
        tag: s.driverId,
        webhook_url: process.env.CERTN_WEBHOOK_URL,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Certn ${res.status}: ${text.slice(0, 200)}`);
    }
    const j: any = await res.json();
    return { ref: String(j.id ?? j.application_id ?? j.uuid), status: 'IN_PROGRESS', provider: 'certn', reportUrl: j.report_url };
  }

  private mockStart(s: BackgroundCheckSubject, onResult: (r: BackgroundCheckResult) => void): BackgroundCheckResult {
    const ref = `mock_${createHash('sha1')
      .update(s.driverId + Date.now())
      .digest('hex')
      .slice(0, 12)}`;
    const delay = parseInt(process.env.CERTN_MOCK_DELAY_MS ?? '4000', 10);
    const status: BgStatus = (s.email ?? '').includes('+consider') ? 'CONSIDER' : 'CLEAR';
    const t = setTimeout(() => {
      try {
        onResult({ ref, status, provider: 'certn-mock' });
      } catch (e: any) {
        this.logger.error(`mock result failed: ${e.message}`);
      }
    }, delay);
    t.unref?.();
    return { ref, status: 'IN_PROGRESS', provider: 'certn-mock' };
  }

  parseWebhook(body: any): BackgroundCheckResult | null {
    const d = body?.data ?? body;
    const ref = d?.id ?? d?.application_id ?? d?.ref ?? body?.ref;
    if (!ref) return null;
    const raw = d?.result ?? d?.status ?? d?.report_result ?? body?.status;
    return { ref: String(ref), status: mapCertnStatus(raw), provider: process.env.CERTN_API_KEY ? 'certn' : 'certn-mock', reportUrl: d?.report_url };
  }
}
