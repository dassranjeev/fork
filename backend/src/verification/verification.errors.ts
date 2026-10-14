import { BadRequestException } from '@nestjs/common';
import { Gate } from './verification.types';

/**
 * 400 for "the checklist is not complete": a code for programs and one line per open item for people. (The error filter forwards `code`
 * and `details`; the full checklist is on the Verification card, GET /admin/verification/drivers/:id or /businesses/:id.)
 */
export function requirementsNotMet(gates: Gate[]) {
  return new BadRequestException({
    message: 'Verification requirements not met',
    code: 'VERIFICATION_REQUIREMENTS_NOT_MET',
    details: gates.filter((g) => !g.done).map((g) => (g.detail ? `${g.label}: ${g.detail}` : g.label)),
  });
}
