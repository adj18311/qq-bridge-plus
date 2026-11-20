import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { SnowLumaWebSocketClient } from '@snowluma/sdk';
import { bindQzoneConnectionEpoch } from '../src/core/qzone-connection-epoch-runtime.mjs';

test('只有连接打开时暴露代际，断开后旧代际失效', () => {
  const bot = new EventEmitter();
  const track = bindQzoneConnectionEpoch(bot);
  assert.equal(track.current(), -1);
  bot.emit('open'); const first = track.current();
  assert.ok(first >= 0);
  bot.emit('close'); assert.equal(track.current(), -1);
  bot.emit('open'); assert.ok(track.current() > first);
  track.close(); assert.equal(track.current(), -1);
  bot.emit('open'); assert.equal(track.current(), -1);
});

test('重复 open 也必须更换代际，无法通过事件重放维持旧身份', () => {
  const bot = new EventEmitter(); const track = bindQzoneConnectionEpoch(bot);
  bot.emit('open'); const first = track.current(); bot.emit('open');
  assert.ok(track.current() > first); track.close();
});

test('不接受无法移除监听的事件源', () => {
  assert.throws(() => bindQzoneConnectionEpoch({ on() {} }));
});

test('实际 SnowLuma SDK 的 on/off 接口支持绑定与移除', () => {
  const bot = new SnowLumaWebSocketClient();
  const track = bindQzoneConnectionEpoch(bot);
  bot.emitter.emit('open');
  assert.ok(track.current() >= 0);
  track.close();
  bot.emitter.emit('open');
  assert.equal(track.current(), -1);
});

test('连接错误后在重新打开前不得继续信任此前代际', () => {
  const bot = new EventEmitter(); const track = bindQzoneConnectionEpoch(bot);
  bot.emit('open'); const first = track.current();
  bot.emit('error', new Error('connection failure'));
  assert.equal(track.current(), -1);
  bot.emit('open'); assert.ok(track.current() > first);
  track.close();
});
