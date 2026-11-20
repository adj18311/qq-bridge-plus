// 鱼塘盯梢策略的纯函数回归：参数解析 / 默认目标 / 事件派生 / 状态地址。
// 全部离线，不碰网络、不碰 state/，也不需要桥接或 DSH。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFishWatchArgs,
  parseFishWatchFlags,
  pickDefaultFishKey,
  deriveFishWatchEvents,
  fishStateUrl,
  FISH_DEFAULT_BASE,
  FISH_MIN_INTERVAL_SECONDS,
  FISH_DEFAULT_INTERVAL_SECONDS,
  FISH_DEFAULT_MINUTES,
  FISH_MAX_MINUTES,
} from '../src/core/fish-watch-policy.mjs';

// ── 参数解析 ────────────────────────────────────────────────────────────────

test('parseFishWatchFlags：同时吃 --k=v 与 --k v，裸开关记空串', () => {
  const { flags, unknown } = parseFishWatchFlags([
    '--room=123456', '--player', 'p-9', '--persist', '--name=鲸鲸', 'junk',
  ]);
  assert.equal(flags.room, '123456');
  assert.equal(flags.player, 'p-9');
  assert.equal(flags.persist, '');
  assert.equal(flags.name, '鲸鲸');
  assert.deepEqual(unknown, ['junk']);
});

test('parseFishWatchArgs：缺 room/player 必须 ok=false 并逐条报错', () => {
  const result = parseFishWatchArgs([]);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 2);
  assert.match(result.errors[0], /--room/);
  assert.match(result.errors[1], /--player/);
});

test('parseFishWatchArgs：合法的完整参数不报错，且间隔/时长被钳到安全区', () => {
  const result = parseFishWatchArgs([
    '--room=1', '--player=2', '--name=鲸鲸',
    '--interval=0', '--minutes=99999',
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.config.room, '1');
  assert.equal(result.config.player, '2');
  assert.equal(result.config.name, '鲸鲸');
  // 0 秒间隔会被钳到下限，否则就是打满桥接的死循环。
  assert.equal(result.config.intervalMs, FISH_MIN_INTERVAL_SECONDS * 1000);
  assert.equal(result.config.intervalSeconds, FISH_MIN_INTERVAL_SECONDS);
  assert.equal(result.config.minutes, FISH_MAX_MINUTES);
});

test('parseFishWatchArgs：不给 interval/minutes 时用默认值，且不把名字缺失当错误', () => {
  const result = parseFishWatchArgs(['--room=1', '--player=2']);
  assert.equal(result.ok, true);
  assert.equal(result.config.intervalSeconds, FISH_DEFAULT_INTERVAL_SECONDS);
  assert.equal(result.config.minutes, FISH_DEFAULT_MINUTES);
  assert.equal(result.config.base, FISH_DEFAULT_BASE);
  // 没给 --name 只是警告：turn_id 可用时仍然能判轮次。
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /--name/);
});

test('parseFishWatchArgs：--base 非 http(s) 直接拒；尾部斜杠被去掉', () => {
  assert.equal(parseFishWatchArgs(['--room=1', '--player=2', '--base=ftp://x']).ok, false);
  const trimmed = parseFishWatchArgs(['--room=1', '--player=2', '--base=https://example.test///']);
  assert.equal(trimmed.ok, true);
  assert.equal(trimmed.config.base, 'https://example.test');
});

test('parseFishWatchArgs：--key 只接受 group:/private: 加数字', () => {
  assert.equal(parseFishWatchArgs(['--room=1', '--player=2', '--key=group:456']).ok, true);
  assert.equal(parseFishWatchArgs(['--room=1', '--player=2', '--key=private:789']).ok, true);
  const bad = parseFishWatchArgs(['--room=1', '--player=2', '--key=456']);
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0], /--key/);
});

test('parseFishWatchArgs：开关语义 —— 出现即真，显式 0/false 才算假', () => {
  const on = parseFishWatchArgs(['--room=1', '--player=2', '--dry-run', '--persist', '--once', '--doctor']);
  assert.equal(on.config.dryRun, true);
  assert.equal(on.config.persist, true);
  assert.equal(on.config.once, true);
  assert.equal(on.config.doctor, true);
  const off = parseFishWatchArgs(['--room=1', '--player=2', '--dry-run=false', '--persist=0']);
  assert.equal(off.config.dryRun, false);
  assert.equal(off.config.persist, false);
});

test('parseFishWatchArgs：非法数字回退默认值而不是 NaN', () => {
  const result = parseFishWatchArgs(['--room=1', '--player=2', '--interval=abc', '--minutes=abc']);
  assert.equal(result.config.intervalSeconds, FISH_DEFAULT_INTERVAL_SECONDS);
  assert.equal(result.config.minutes, FISH_DEFAULT_MINUTES);
});

// ── 默认目标 ────────────────────────────────────────────────────────────────

test('pickDefaultFishKey：优先白名单第一个群', () => {
  assert.deepEqual(
    pickDefaultFishKey({ allowGroups: ['456', '789'], allowPrivate: ['123'], ownerQQ: 123 }),
    { key: 'group:456', reason: '白名单第一个群' },
  );
});

test('pickDefaultFishKey：没有群就用第一个私聊，再退到 ownerQQ', () => {
  assert.deepEqual(
    pickDefaultFishKey({ allowGroups: [], allowPrivate: ['123'], ownerQQ: 999 }),
    { key: 'private:123', reason: '白名单第一个私聊' },
  );
  assert.deepEqual(
    pickDefaultFishKey({ allowGroups: [], allowPrivate: [], ownerQQ: '999' }),
    { key: 'private:999', reason: 'ownerQQ' },
  );
});

test('pickDefaultFishKey：全空时返回空 key，调用方必须拒绝运行而不是瞎猜', () => {
  const picked = pickDefaultFishKey({ allowGroups: [], allowPrivate: [], ownerQQ: '' });
  assert.equal(picked.key, '');
});

test('pickDefaultFishKey：忽略空白项，不做类型假设', () => {
  assert.equal(pickDefaultFishKey({ allowGroups: ['  ', '456'] }).key, 'group:456');
  assert.equal(pickDefaultFishKey({ allowGroups: undefined, allowPrivate: undefined, ownerQQ: null }).key, '');
});

// ── 事件派生 ────────────────────────────────────────────────────────────────

const BASE_STATE = {
  phase: 'speaking',
  round: 3,
  players: [{ id: 'p-1', name: '鲸鲸', said: false, voted: false }],
  turn_name: '鲸鲸',
};

test('deriveFishWatchEvents：轮到我说词且没说过 → 一条说话提醒', () => {
  const result = deriveFishWatchEvents({ state: BASE_STATE, playerId: 'p-1', playerName: '鲸鲸', room: '42' });
  assert.equal(result.action, 'continue');
  assert.equal(result.reason, 'notify');
  assert.equal(result.events.length, 1);
  assert.match(result.events[0], /第 3 轮轮到你了/);
  assert.deepEqual(result.ids, ['say:3']);
});

test('deriveFishWatchEvents：已经说过就不再叫（省 token 的核心）', () => {
  const said = { ...BASE_STATE, players: [{ id: 'p-1', name: '鲸鲸', said: true, voted: false }] };
  const result = deriveFishWatchEvents({ state: said, playerId: 'p-1', playerName: '鲸鲸' });
  assert.equal(result.reason, 'nothing-to-do');
  assert.deepEqual(result.events, []);
});

test('deriveFishWatchEvents：turn_id 优先于 turn_name（昵称可能重名）', () => {
  // turn_name 撞上我的昵称，但 turn_id 指向别人 → 不该叫我。
  const otherTurn = { ...BASE_STATE, turn_id: 'p-2' };
  assert.deepEqual(
    deriveFishWatchEvents({ state: otherTurn, playerId: 'p-1', playerName: '鲸鲸' }).events,
    [],
  );
  // turn_id 是我，即使 turn_name 完全不对 → 必须叫我。
  const myTurn = { ...BASE_STATE, turn_id: 'p-1', turn_name: '别人' };
  assert.equal(
    deriveFishWatchEvents({ state: myTurn, playerId: 'p-1', playerName: '鲸鲸' }).events.length,
    1,
  );
});

test('deriveFishWatchEvents：投票阶段未投 → 一条投票提醒', () => {
  const voting = { ...BASE_STATE, phase: 'voting' };
  const result = deriveFishWatchEvents({ state: voting, playerId: 'p-1', playerName: '鲸鲸' });
  assert.equal(result.events.length, 1);
  assert.match(result.events[0], /第 3 轮投票/);
  assert.deepEqual(result.ids, ['vote:3']);
});

test('deriveFishWatchEvents：已投票不再叫', () => {
  const voted = { ...BASE_STATE, phase: 'voting', players: [{ id: 'p-1', name: '鲸鲸', said: true, voted: true }] };
  assert.deepEqual(deriveFishWatchEvents({ state: voted, playerId: 'p-1', playerName: '鲸鲸' }).events, []);
});

test('deriveFishWatchEvents：结束局返回 action=stop 并带上卧底与胜负', () => {
  const ended = {
    phase: 'ended',
    round: 5,
    winner: 'undercover',
    reveal: [{ id: 'p-2', name: '老王', role: 'undercover', word: '苹果' }],
  };
  const result = deriveFishWatchEvents({ state: ended, playerId: 'p-1', room: '42' });
  assert.equal(result.action, 'stop');
  assert.equal(result.events.length, 1);
  assert.match(result.events[0], /卧底赢/);
  assert.match(result.events[0], /老王/);
  assert.match(result.events[0], /苹果/);
});

test('deriveFishWatchEvents：already 命中的去重键不再重复投递', () => {
  const said = deriveFishWatchEvents({
    state: BASE_STATE, playerId: 'p-1', playerName: '鲸鲸', already: new Set(['say:3']),
  });
  assert.deepEqual(said.events, []);

  const ended = deriveFishWatchEvents({
    state: { phase: 'ended', round: 1, winner: 'civilian', reveal: [] },
    playerId: 'p-1', already: ['ended'],
  });
  assert.equal(ended.action, 'stop');
  assert.deepEqual(ended.events, []);
  assert.equal(ended.reason, 'already-ended');
});

test('deriveFishWatchEvents：状态形状不对时继续轮询而不是崩', () => {
  for (const state of [null, undefined, {}, { phase: '' }, 42, 'x']) {
    const result = deriveFishWatchEvents({ state, playerId: 'p-1' });
    assert.equal(result.action, 'continue');
    assert.equal(result.reason, 'no-phase');
    assert.deepEqual(result.events, []);
  }
});

test('deriveFishWatchEvents：players 缺失时不抛异常，只按 turn 判定', () => {
  const noPlayers = { phase: 'voting', round: 2, turn_name: '鲸鲸' };
  const result = deriveFishWatchEvents({ state: noPlayers, playerId: 'p-1', playerName: '鲸鲸' });
  // 拿不到 me.voted → 视为未投票，仍然该叫（宁可多叫一次，不要漏投）。
  assert.equal(result.events.length, 1);
});

test('deriveFishWatchEvents：非 speaking/voting 的阶段什么都不叫', () => {
  for (const phase of ['waiting', 'reveal', 'starting']) {
    const result = deriveFishWatchEvents({ state: { ...BASE_STATE, phase }, playerId: 'p-1', playerName: '鲸鲸' });
    assert.equal(result.reason, 'nothing-to-do');
    assert.deepEqual(result.events, []);
  }
});

// ── 状态地址 ────────────────────────────────────────────────────────────────

test('fishStateUrl：带 cache-buster，并对 room/player 做 URL 编码', () => {
  const url = fishStateUrl({ base: 'https://x.test///', room: '12 3', player: 'p&1', now: 1700000000000 });
  assert.equal(url, 'https://x.test/web/state?room=12%203&player_id=p%261&t=1700000000000');
});
