import test from 'node:test';
import assert from 'node:assert/strict';
import { createQzoneOwnerNoticeSender } from '../src/core/qzone-owner-notice-adapter.mjs';

test('only an existing owner sender receipt with valid message ID proves success', async () => {
  const sent = [];
  const sender = createQzoneOwnerNoticeSender(async message => {
    sent.push(message); return { outcome: 'delivered', messageId: '-123' };
  });
  assert.equal(await sender('notice'), 'success');
  assert.deepEqual(sent, ['notice']);
});

test('failed, missing, malformed, or thrown sender results remain unknown', async () => {
  for (const fake of [async () => ({ outcome: 'failed', code: 'secret' }),
    async () => ({ outcome: 'delivered', messageId: '0' }), async () => ({ outcome: 'unknown' }),
    async () => { throw new Error('Bearer secret'); }]) {
    assert.equal(await createQzoneOwnerNoticeSender(fake)('notice'), 'unknown');
  }
});

test('pre-aborted call is never sent; caller cannot choose owner target', async () => {
  let calls = 0;
  const sender = createQzoneOwnerNoticeSender(async () => { calls++; return { outcome: 'delivered', messageId: '1' }; });
  const controller = new AbortController(); controller.abort();
  assert.equal(await sender('notice', { signal: controller.signal }), 'unknown');
  assert.equal(calls, 0);
});
