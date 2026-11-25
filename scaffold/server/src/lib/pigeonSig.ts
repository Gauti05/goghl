import crypto from 'node:crypto';

export type SigVerifyResult =
  | { ok: true; timestamp: number }
  | { ok: false; reason: string };

/**
 * Verify Pigeon's `x-pigeon-signature: t=<unix>,v1=<hex>` header against the
 * exact raw request body Buffer and enforce the 300-second replay window.
 */
export function verifyPigeonSignature(
  sigHeader: string | string[] | undefined,
  rawBody: Buffer,
  secret: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): SigVerifyResult {
  if (!sigHeader || typeof sigHeader !== 'string') {
    return { ok: false, reason: 'missing signature' };
  }

  const sigMatch = sigHeader.match(/^t=(\d+),v1=([0-9a-f]+)$/i);
  if (!sigMatch) {
    return { ok: false, reason: 'malformed signature' };
  }

  const t = parseInt(sigMatch[1]!, 10);
  const providedMac = sigMatch[2]!;

  if (isNaN(t)) {
    return { ok: false, reason: 'invalid timestamp' };
  }

  if (Math.abs(nowSec - t) > 300) {
    return { ok: false, reason: 'timestamp too old or too far in future' };
  }

  const expectedMac = crypto
    .createHmac('sha256', secret)
    .update(`${t}.`)
    .update(rawBody)
    .digest('hex');

  let macValid = false;
  try {
    macValid = crypto.timingSafeEqual(
      Buffer.from(expectedMac, 'hex'),
      Buffer.from(providedMac.toLowerCase(), 'hex'),
    );
  } catch {
    macValid = false;
  }

  if (!macValid) {
    return { ok: false, reason: 'signature mismatch' };
  }

  return { ok: true, timestamp: t };
}
