// 鱼塘盯梢 CLI 的行为级回归：用假 fetch + 虚拟时钟驱动真实 runFishWatch 主流程。
// 锁三件事：
//   1) 只在「轮到我 / 该投票 / 结束」时投递，其余轮次一次都不发（省 token 的本意）；
//   2) 投递失败绝不写入去重键（否则漏一轮就直接输）；
//   3) 结束时只叫一次、404 立即收工、--dry-run 不真的打桥接。
// 全部离线：不读 config.json、不碰 state/、不起 http server。
import test from 'node:test';
import assert from 'node:assert/strict';
import { runFishWatch } from './fish-watch.mjs';

function responseStub(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      if (payload === null) throw new Error('no body');
      return payload;
    },
  };
}

/** 造一个按脚本回答的假 fetch：/web/state 走站点，notify-ai 走桥接。 */
function fakeFetch({ states = [], onNotify } = {}) {
  const calls = { state: 0, notify: [] };
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    if (target.includes('/web/state')) {
      const index = Math.min(calls.state, states.length - 1);
      calls.state += 1;
      const entry = states[index];
      if (entry === 'network-error') throw new Error('fetch failed');
      if (entry === 404) return responseStub(404, null);
      return responseStub(200, entry);
    }
    if (target.includes('/api/console/notify-ai')) {
      const body = JSON.parse(init.body ?? '{}');
      calls.notify.push(body);
      if (onNotify) return onNotify(body, calls.notify.length);
      return responseStub(200, { ok: true, key: body.key, sessionId: 'fixture-session' });
    }
    if (target.includes('/api/status')) {
      return responseStub(200, {
        mode: 'reserved2', dshReady: true, socialV2Paused: false,
        allowGroups: ['1059972926'], allowPrivate: ['1234567890'],
      });
    }
    return responseStub(404, null);
  };
  return { fetchImpl, calls };
}

function 收集器() {
  const lines = [];
  const errors = [];
  return {
    log: (...parts) => lines.push(parts.join(' ')),
    logError: (...parts) => errors.push(parts.join(' ')),
    lines,
    errors,
    text: () => [...lines, ...errors].join('\n'),
  };
}

/**
 * 虚拟时钟：sleep 不真的等，但把 now 推前 —— 主循环的截止条件依赖它。
 * `frozen: true` 时 time 永不前进，用来验证「时钟不走也不会无限轮询」的护栏。
 */
function 虚拟时钟(intervalMs = 8000, { frozen = false } = {}) {
  let now = 1_700_000_000_000;
  return {
    now: () => now,
    sleep: async (ms) => { if (!frozen) now += Number(ms) || intervalMs; },
  };
}

const 配置 = {
  consolePort: 3100,
  consoleToken: 'fixture-console-token',
  allow: { groups: ['1059972926'], private: ['1234567890'] },
  ownerQQ: 1234567890,
};

const 基础参数 = ['--room=42', '--player=p-1', '--name=鲸鲸', '--base=https://fish.test'];

/** 一次 speaking 轮到我 + 一次投票 + 一整轮无动作 + 结束。 */
const 完整一局 = [
  { phase: 'speaking', round: 1, turn_id: 'p-1', players: [{ id: 'p-1', name: '鲸鲸', said: false, voted: false }] },
  { phase: 'voting', round: 2, players: [{ id: 'p-1', name: '鲸鲸', said: true, voted: false }] },
  { phase: 'voting', round: 3, players: [{ id: 'p-1', name: '鲸鲸', said: true, voted: true }] },
  { phase: 'ended', round: 3, winner: 'civilian', reveal: [] },
];

/** 统一跑一次：注入假 fetch、虚拟时钟、静默日志。 */
async function 跑(argv, { states, onNotify, config = 配置, fetchWrap, intervalMs, frozen = false, token } = {}) {
  const fake = fakeFetch({ states, onNotify });
  const clock = 虚拟时钟(intervalMs, { frozen });
  const out = 收集器();
  const code = await runFishWatch({
    argv,
    fetchImpl: fetchWrap ? (url, init) => fetchWrap(url, init, fake.fetchImpl) : fake.fetchImpl,
    log: out.log,
    logError: out.logError,
    print: out.log,
    sleep: clock.sleep,
    now: clock.now,
    readConfig: () => config,
    // 令牌默认强制给出：测试不该依赖运行目录里真实存在的 state/console-token。
    readToken: (cfg, override) => override || token || 'fixture-console-token',
  });
  return { code, calls: fake.calls, out, clock };
}

test('runFishWatch：只在三个关键点投递，其余轮次零投递', async () => {
  const { code, calls, out } = await 跑(基础参数, { states: 完整一局 });
  assert.equal(code, 0);
  // 第 1 轮说话、第 2 轮投票、结束各一条；第 3 轮已投票 → 不发。
  assert.equal(calls.notify.length, 3, out.text());
  assert.match(calls.notify[0].message, /第 1 轮轮到你了/);
  assert.match(calls.notify[1].message, /第 2 轮投票/);
  assert.match(calls.notify[2].message, /结束了/);
  // 全部投给自动挑出来的第一个群，且 body 形状必须是 notify-ai 认的 {key, message}。
  for (const body of calls.notify) assert.equal(body.key, 'group:1059972926');
});

test('runFishWatch：--key 覆盖自动选择，且不再打印自动选择提示', async () => {
  const { calls, out } = await 跑([...基础参数, '--key=private:1234567890'], { states: 完整一局 });
  assert.equal(calls.notify.length, 3);
  for (const body of calls.notify) assert.equal(body.key, 'private:1234567890');
  assert.ok(!out.text().includes('自动选中'), '不该再走自动选择分支');
});

test('runFishWatch：投递失败不写去重键，下一轮重试同一条', async () => {
  // 站点状态不变（一直轮到我），桥接第一次拒绝、第二次接受。
  const 不变状态 = { phase: 'speaking', round: 1, turn_id: 'p-1', players: [{ id: 'p-1', said: false, voted: false }] };
  const { calls, out } = await 跑(基础参数, {
    states: [不变状态, 不变状态, 不变状态],
    onNotify: (_body, nth) => (nth === 1
      ? responseStub(403, { ok: false, error: '目标不在白名单内' })
      : responseStub(200, { ok: true, sessionId: 's' })),
  });
  // 第 1 次 403（失败），第 2 次成功并写去重键，第 3 次因去重键不再发。
  assert.equal(calls.notify.length, 2, out.text());
  assert.match(out.text(), /投递失败/);
  assert.equal(calls.notify[0].message, calls.notify[1].message, '失败后重试的必须是同一条提醒');
});

test('runFishWatch：真实投递一次成功后，同一轮不再重复叫', async () => {
  const 不变状态 = { phase: 'speaking', round: 7, turn_id: 'p-1', players: [{ id: 'p-1', said: false, voted: false }] };
  const { calls } = await 跑(基础参数, { states: [不变状态, 不变状态, 不变状态, 不变状态] });
  assert.equal(calls.notify.length, 1, '同一轮只能叫一次');
});

test('runFishWatch：--dry-run 只打印不投递', async () => {
  const 不变状态 = { phase: 'speaking', round: 4, turn_id: 'p-1', players: [{ id: 'p-1', said: false, voted: false }] };
  const { calls, out } = await 跑([...基础参数, '--dry-run'], { states: [不变状态, 不变状态] });
  assert.equal(calls.notify.length, 0, 'dry-run 绝不能真的打桥接');
  assert.match(out.text(), /\[dry-run\] 本来要投给/);
});

test('runFishWatch：404 立即收工，不做任何重试', async () => {
  const { code, calls, out } = await 跑(基础参数, { states: [404, 404, 404] });
  assert.equal(code, 0);
  assert.equal(calls.state, 1, '404 之后不该再抓第二次');
  assert.equal(calls.notify.length, 0);
  assert.match(out.text(), /房间不存在/);
});

test('runFishWatch：--once 网络失败只查一次就收尾，不变成常驻重试', async () => {
  const { code, calls, out } = await 跑([...基础参数, '--once'], { states: ['network-error'] });
  assert.equal(code, 0);
  assert.equal(calls.state, 1, '--once 不能重试');
  assert.match(out.text(), /抓取失败/);
});

test('runFishWatch：--once 打印判定结果且只抓一次', async () => {
  const { calls, out } = await 跑([...基础参数, '--once'], { states: [完整一局[0]] });
  assert.equal(calls.state, 1);
  assert.equal(calls.notify.length, 1, '--once 仍按正常逻辑投递一次（只是不循环）');
  assert.match(out.text(), /\[once\] phase=speaking/);
});

test('runFishWatch：--help 打印用法并返回 0，不需要 --room/--player', async () => {
  const { code, calls, out } = await 跑(['--help'], { states: [] });
  assert.equal(code, 0);
  assert.equal(calls.state, 0);
  assert.match(out.text(), /--room=<房间号>/);
  assert.match(out.text(), /--doctor/);
});

test('runFishWatch：缺 --room/--player 返回 2，且完全不发请求', async () => {
  const { code, calls, out } = await 跑([], { states: [] });
  assert.equal(code, 2);
  assert.equal(calls.state, 0);
  assert.equal(calls.notify.length, 0);
  assert.match(out.text(), /参数错误/);
});

test('runFishWatch：拿不到令牌返回 2，不发请求', async () => {
  const fake = fakeFetch({ states: [] });
  const out = 收集器();
  const clock = 虚拟时钟();
  const code = await runFishWatch({
    argv: 基础参数,
    fetchImpl: fake.fetchImpl,
    log: out.log,
    logError: out.logError,
    sleep: clock.sleep,
    now: clock.now,
    readConfig: () => ({ consolePort: 3100, allow: { groups: ['1059972926'] } }),
    // 既没有 consoleToken，也不给 --token：必须停在参数校验阶段。
    readToken: () => '',
  });
  assert.equal(code, 2);
  assert.equal(fake.calls.state, 0);
  assert.match(out.text(), /控制台令牌/);
});

test('runFishWatch：白名单全空且没给 --key 时返回 2，不瞎猜目标', async () => {
  const { code, calls } = await 跑(基础参数, {
    states: [],
    config: { consolePort: 3100, consoleToken: 't', allow: { groups: [], private: [] }, ownerQQ: '' },
  });
  assert.equal(code, 2);
  assert.equal(calls.notify.length, 0);
});

test('runFishWatch：--doctor 全通返回 0 且不投递', async () => {
  const { code, calls, out } = await 跑([...基础参数, '--doctor'], { states: [完整一局[0]] });
  assert.equal(code, 0, out.text());
  assert.equal(calls.notify.length, 0, '--doctor 不该投递任何东西');
  assert.match(out.text(), /目标会话 group:1059972926 在白名单内/);
});

test('runFishWatch：--doctor 站点不通返回 1', async () => {
  // 用默认 base 才会出现「这是原脚本里的隧道」的针对性提示；否则只报连不上。
  const { code, out } = await 跑(['--room=42', '--player=p-1', '--doctor'], { states: ['network-error'] });
  assert.equal(code, 1, out.text());
  assert.match(out.text(), /连不上站点/);
  assert.match(out.text(), /trycloudflare 隧道/);
});

test('runFishWatch：--doctor 发现目标不在白名单 / 非 reserved2 / 已暂停都要报出来', async () => {
  const { code, out } = await 跑([...基础参数, '--doctor', '--key=group:999999'], {
    states: [完整一局[0]],
    config: 配置,
    fetchWrap: (url, init, inner) => {
      if (String(url).includes('/api/status')) {
        return responseStub(200, {
          mode: 'chat', dshReady: true, socialV2Paused: true,
          allowGroups: ['1059972926'], allowPrivate: ['1234567890'],
        });
      }
      return inner(url, init);
    },
  });
  assert.equal(code, 1);
  assert.match(out.text(), /不在白名单/);
  assert.match(out.text(), /只在 reserved2/);
  assert.match(out.text(), /暂停/);
});

test('runFishWatch：时钟冻结时护栏生效，永不结束的局不会无限轮询', async () => {
  const 不变状态 = { phase: 'starting', round: 0, players: [] };
  // 1 分钟 / 8 秒 → 上限 = ceil(60000/8000)+8 = 16 次。时钟冻结模拟「sleep 被换成空实现」。
  const { code, calls, out } = await 跑(
    [...基础参数, '--minutes=1', '--interval=8'],
    { states: Array.from({ length: 40 }, () => 不变状态), frozen: true },
  );
  assert.equal(code, 0);
  assert.ok(calls.state <= 16, `抓取次数 ${calls.state} 超过护栏上限`);
  assert.match(out.text(), /达到上限/);
});

test('runFishWatch：时钟正常前进时由截止时间退出，而不是撞护栏', async () => {
  const 不变状态 = { phase: 'starting', round: 0, players: [] };
  const { code, calls, out } = await 跑(
    [...基础参数, '--minutes=1', '--interval=8'],
    { states: Array.from({ length: 40 }, () => 不变状态) },
  );
  assert.equal(code, 0);
  // 1 分钟 / 8 秒 = 8 次（0s,8s,...,56s）+ 边界，绝不该跑到护栏。
  assert.ok(calls.state >= 7 && calls.state <= 9, `抓取次数 ${calls.state} 不符合按时间退出`);
  assert.ok(!out.text().includes('达到上限'), '正常退出不该报护栏');
});
