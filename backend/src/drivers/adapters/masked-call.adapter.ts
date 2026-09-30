import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';

export interface MaskedCallSession {
  sessionId: string;
  /** Number the driver dials; it bridges to the real party without exposing either number. */
  proxyNumber: string;
  expiresAt: string;
  provider: string;
}

export interface MaskedCallInput {
  orderId: string;
  orderCode: string;
  driverPhone: string | null;
  targetPhone: string | null;
  party: 'CUSTOMER' | 'RESTAURANT';
}

export interface MaskedCallProvider {
  readonly name: string;
  createSession(input: MaskedCallInput): Promise<MaskedCallSession>;
}

/**
 * Masked calling behind an interface. Default = mock (deterministic placeholder number, no real bridge).
 * Twilio Proxy is used when TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_PROXY_SERVICE_SID are configured.
 */
@Injectable()
export class MaskedCallAdapter implements MaskedCallProvider {
  private readonly logger = new Logger('MaskedCall');

  get name() {
    return process.env.TWILIO_PROXY_SERVICE_SID && process.env.TWILIO_ACCOUNT_SID ? 'twilio-proxy' : 'mock';
  }

  async createSession(input: MaskedCallInput): Promise<MaskedCallSession> {
    if (this.name === 'twilio-proxy' && input.driverPhone && input.targetPhone) {
      try {
        return await this.twilio(input);
      } catch (e: any) {
        this.logger.warn(`Twilio Proxy failed, using mock: ${e.message}`);
      }
    }
    const h = createHash('md5').update(`${input.orderId}:${input.party}`).digest('hex');
    const n = parseInt(h.slice(0, 6), 16) % 10000;
    return {
      sessionId: `mock_${h.slice(0, 10)}`,
      proxyNumber: `+1 (647) 555-${String(n).padStart(4, '0')}`,
      expiresAt: new Date(Date.now() + 2 * 3600_000).toISOString(),
      provider: 'mock',
    };
  }

  private async twilio(input: MaskedCallInput): Promise<MaskedCallSession> {
    const sid = process.env.TWILIO_ACCOUNT_SID!;
    const auth = 'Basic ' + Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
    const base = `https://proxy.twilio.com/v1/Services/${process.env.TWILIO_PROXY_SERVICE_SID}`;
    const headers = { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' };
    const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
    const s = await fetch(`${base}/Sessions`, { method: 'POST', headers, body: form({ UniqueName: `${input.orderCode}-${input.party}-${Date.now()}`, Ttl: '7200' }) });
    if (!s.ok) throw new Error(`session ${s.status}`);
    const session: any = await s.json();
    const add = async (phone: string) => {
      const r = await fetch(`${base}/Sessions/${session.sid}/Participants`, { method: 'POST', headers, body: form({ Identifier: phone }) });
      if (!r.ok) throw new Error(`participant ${r.status}`);
      return (await r.json()) as any;
    };
    const driver = await add(input.driverPhone!);
    await add(input.targetPhone!);
    return { sessionId: session.sid, proxyNumber: driver.proxy_identifier, expiresAt: new Date(Date.now() + 7200_000).toISOString(), provider: 'twilio-proxy' };
  }
}
