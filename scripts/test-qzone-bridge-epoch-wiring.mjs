import test from 'node:test';
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { bindQzoneConnectionEpoch } from '../src/core/qzone-connection-epoch-runtime.mjs';

test('桥接构造 SnowLuma 客户端后先绑定连接代际，不发起任何 QQ 请求', async (t) => {
  const observed = [];
  const h = await bridgeHarness({ globals: { bindQzoneConnectionEpoch(bot) {
    observed.push(bot);
    return { current: () => -1, close() {} };
  } } });
  t.after(() => h.close());
  assert.equal(observed.length, 1);
  assert.equal(typeof observed[0].request, 'function');
  assert.equal(h.calls.sent.length, 0);
});

test('桥接持有的同一客户端事件使代际在断线后失效并随重连变化', async (t) => {
  let bot, tracker;
  const h = await bridgeHarness({ globals: { bindQzoneConnectionEpoch(value) {
    bot = value; tracker = bindQzoneConnectionEpoch(value); return tracker;
  } } });
  t.after(() => { tracker.close(); return h.close(); });
  assert.equal(tracker.current(), -1);
  bot.emit('open');
  const first = tracker.current();
  assert.ok(first > 0);
  bot.emit('close');
  assert.equal(tracker.current(), -1);
  bot.emit('open');
  assert.ok(tracker.current() > first);
  assert.equal(h.calls.sent.length, 0);
});
