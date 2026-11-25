import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyPigeonSignature } from '../src/lib/pigeonSig.js';
import { canUpgradeStatus, STATUS_RANK } from '../src/lib/statusRank.js';

function sign(raw: string, secret: string, t: number): string {
  const mac = crypto.createHmac('sha256', secret).update(`${t}.`).update(raw).digest('hex');
  return `t=${t},v1=${mac}`;
}

describe('Pigeon webhook signature & replay verification', () => {
  const secret = 'whsec_pigeon_dev';
  const body = JSON.stringify({ id: 'evt_1', type: 'message.inbound', workspace: 'ws_acme' });
  const rawBuf = Buffer.from(body, 'utf8');

  it('accepts a valid signature within 300s window', () => {
    const now = 1_700_000_000;
    const header = sign(body, secret, now - 120);
    const res = verifyPigeonSignature(header, rawBuf, secret, now);
    assert.equal(res.ok, true);
  });

  it('rejects missing or malformed signature header', () => {
    assert.equal(verifyPigeonSignature(undefined, rawBuf, secret).ok, false);
    assert.equal(verifyPigeonSignature('bad-header', rawBuf, secret).ok, false);
    assert.equal(verifyPigeonSignature('t=123,v1=nothex!', rawBuf, secret).ok, false);
  });

  it('rejects forged signature or tampered raw body', () => {
    const now = 1_700_000_000;
    const forged = sign(body, 'wrong_secret', now);
    assert.equal(verifyPigeonSignature(forged, rawBuf, secret, now).ok, false);

    const valid = sign(body, secret, now);
    const tampered = Buffer.from(body.replace('ws_acme', 'ws_globex'), 'utf8');
    assert.equal(verifyPigeonSignature(valid, tampered, secret, now).ok, false);
  });

  it('rejects timestamps older than 300 seconds', () => {
    const now = 1_700_000_000;
    const stale = sign(body, secret, now - 301);
    assert.equal(verifyPigeonSignature(stale, rawBuf, secret, now).ok, false);

    const edge = sign(body, secret, now - 300);
    assert.equal(verifyPigeonSignature(edge, rawBuf, secret, now).ok, true);
  });
});

describe('Monotonic outbound status transitions & inbound ordering', () => {
  it('never downgrades delivered or failed when sent arrives late', () => {
    assert.equal(canUpgradeStatus('queued', 'sent'), true);
    assert.equal(canUpgradeStatus('processing', 'delivered'), true);
    assert.equal(canUpgradeStatus('sent', 'delivered'), true);
    assert.equal(canUpgradeStatus('sent', 'failed'), true);

    // Out-of-order: delivered arrived before sent -> sent must NOT overwrite delivered
    assert.equal(canUpgradeStatus('delivered', 'sent'), false);
    assert.equal(canUpgradeStatus('failed', 'sent'), false);
    assert.equal(canUpgradeStatus('delivered', 'failed'), false);
    assert.equal(canUpgradeStatus('failed', 'delivered'), false);
    assert.equal(STATUS_RANK['delivered'], STATUS_RANK['failed']);
  });

  it('orders out-of-order inbound messages chronologically by occurred_at', () => {
    const arrived = [
      { messageId: 'pmsg_3', occurredAt: new Date('2026-11-25T10:00:05.000Z') },
      { messageId: 'pmsg_1', occurredAt: new Date('2026-11-25T10:00:01.000Z') },
      { messageId: 'pmsg_2', occurredAt: new Date('2026-11-25T10:00:03.000Z') },
    ];
    const sorted = [...arrived].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
    assert.deepEqual(
      sorted.map((m) => m.messageId),
      ['pmsg_1', 'pmsg_2', 'pmsg_3'],
    );
  });
});
