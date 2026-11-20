/**
 * 小黑盒控制台专栏配置模型（xiaoheihe-console-settings）离线测试。
 * 断言只针对任务卡明确要求的语义，不测「实现细节恰好如此」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const settingsModulePath = path.join(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
  'src',
  'core',
  'xiaoheihe-console-settings.mjs',
);

import {
  XHH_CONSOLE_CAPABILITY_KEYS,
  XHH_CONSOLE_QUOTA_KEYS,
  XHH_CONSOLE_QUOTA_MAX,
  XHH_CONSOLE_SETTINGS_DEFAULTS,
  XHH_CONSOLE_SETTINGS_RELATIVE_PATH,
  beijingMinutesOfDay,
  capabilityOfTool,
  decideCapability,
  decidePatrolDispatch,
  failSafeSettings,
  loadSettings,
  normalizeSettings,
  parseWindowMinutes,
  saveSettings,
  windowContains,
} from '../src/core/xiaoheihe-console-settings.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xhh-console-settings-'));
}

test('默认值：四个开关全开、非只读、巡逻开、时段 07:00–23:00、额度 14/2/12', () => {
  assert.deepEqual([...XHH_CONSOLE_CAPABILITY_KEYS], ['browse', 'post', 'comment', 'reply']);
  assert.deepEqual([...XHH_CONSOLE_QUOTA_KEYS], ['browse', 'post', 'comment']);
  assert.equal(XHH_CONSOLE_QUOTA_MAX, 99);
  assert.equal(XHH_CONSOLE_SETTINGS_RELATIVE_PATH, 'state/xiaoheihe-console-settings.json');
  const input = {};
  const result = normalizeSettings(input);
  assert.equal(result.ok, true);
  assert.deepEqual(result.settings.capabilities, { browse: true, post: true, comment: true, reply: true });
  assert.equal(result.settings.readOnly, false);
  assert.deepEqual(result.settings.patrol, { enabled: true, window: { start: '07:00', end: '23:00' } });
  assert.deepEqual(result.settings.quota, { browse: 14, post: 2, comment: 12 });
  // 默认值对象本身不可被外部改写（返回的是副本）。
  result.settings.capabilities.browse = false;
  assert.equal(XHH_CONSOLE_SETTINGS_DEFAULTS.capabilities.browse, true);
});

test('校验：未知键/未知能力/非布尔/非法时段/非法额度一律拒绝并带字段', () => {
  const cases = [
    [{ nope: 1 }, 'unknown-field'],
    [{ capabilities: { reading: true } }, 'unknown-field'],
    [{ capabilities: { browse: 'yes' } }, 'invalid-capability-value'],
    [{ readOnly: 1 }, 'invalid-read-only'],
    [{ patrol: { enabled: 'on' } }, 'invalid-patrol-enabled'],
    [{ patrol: { window: { start: '7:00' } } }, 'invalid-window-time'],
    [{ patrol: { window: { start: '24:00' } } }, 'invalid-window-time'],
    [{ patrol: { window: { start: '07:00', end: '07:60' } } }, 'invalid-window-time'],
    [{ quota: { browse: -1 } }, 'invalid-quota-value'],
    [{ quota: { browse: 100 } }, 'invalid-quota-value'],
    [{ quota: { browse: 1.5 } }, 'invalid-quota-value'],
    [{ quota: { browse: '14' } }, 'invalid-quota-value'],
    [{ quota: { browse: null } }, 'invalid-quota-value'],
    [{ schemaVersion: 2 }, 'schema-version-unsupported'],
  ];
  for (const [input, reason] of cases) {
    const result = normalizeSettings(input);
    assert.equal(result.ok, false, `应拒绝：${JSON.stringify(input)}`);
    assert.equal(result.reason, reason, `reason 不符：${JSON.stringify(input)}`);
  }
  // 0 与 99 都是合法值（0 = 禁止该类自主操作，99 = 上限）。
  assert.equal(normalizeSettings({ quota: { browse: 0 } }).settings.quota.browse, 0);
  assert.equal(normalizeSettings({ quota: { post: 99 } }).settings.quota.post, 99);
});

test('时间段：普通区间 / 跨午夜 / 开始等于结束=全天 / 非法文本', () => {
  const at = (hour, minute = 0) => new Date(2026, 9, 30, hour, minute, 0, 0);
  assert.equal(parseWindowMinutes('07:00'), 420);
  assert.equal(parseWindowMinutes('7:00'), null);
  assert.equal(parseWindowMinutes('23:60'), null);

  const daytime = { start: '07:00', end: '23:00' };
  assert.equal(windowContains(daytime, at(6, 59)), false);
  assert.equal(windowContains(daytime, at(7, 0)), true);
  assert.equal(windowContains(daytime, at(22, 59)), true);
  assert.equal(windowContains(daytime, at(23, 0)), false);

  const overnight = { start: '23:00', end: '07:00' };
  assert.equal(windowContains(overnight, at(23, 0)), true);
  assert.equal(windowContains(overnight, at(2, 0)), true);
  assert.equal(windowContains(overnight, at(6, 59)), true);
  assert.equal(windowContains(overnight, at(7, 0)), false);
  assert.equal(windowContains(overnight, at(12, 0)), false);

  const allDay = { start: '09:00', end: '09:00' };
  assert.equal(windowContains(allDay, at(0, 0)), true);
  assert.equal(windowContains(allDay, at(9, 0)), true);
  assert.equal(windowContains(allDay, at(23, 59)), true);

  assert.equal(windowContains({ start: 'bad', end: '07:00' }, at(12)), false);
});

test('门禁判定：开关关闭拒所有来源；只读只拒写三类；浏览不受只读影响', () => {
  const settings = normalizeSettings({}).settings;
  for (const capability of ['browse', 'post', 'comment', 'reply']) {
    assert.deepEqual(decideCapability(settings, capability), { allowed: true, reason: null });
  }

  const postOff = normalizeSettings({ capabilities: { post: false } }).settings;
  assert.deepEqual(decideCapability(postOff, 'post'), { allowed: false, reason: 'console-capability-off-post' });
  assert.equal(decideCapability(postOff, 'browse').allowed, true);

  const readOnly = normalizeSettings({ readOnly: true }).settings;
  assert.deepEqual(decideCapability(readOnly, 'browse'), { allowed: true, reason: null });
  for (const capability of ['post', 'comment', 'reply']) {
    assert.deepEqual(decideCapability(readOnly, capability), { allowed: false, reason: 'console-read-only' });
  }

  // 只读 + 开关关闭时，开关优先（reason 指向开关，便于排查是哪一层拒绝）。
  const both = normalizeSettings({ readOnly: true, capabilities: { reply: false } }).settings;
  assert.deepEqual(decideCapability(both, 'reply'), { allowed: false, reason: 'console-capability-off-reply' });

  assert.deepEqual(decideCapability(settings, 'unknown'), { allowed: false, reason: 'console-capability-unknown' });
});

test('工具映射：搜索/资料/登录态跟浏览；发帖三件套→post；评论/回复分开；登录写入类不在门禁范围', () => {
  assert.equal(capabilityOfTool('get_home_content'), 'browse');
  assert.equal(capabilityOfTool('mcp__xiaoheihe__get_post_detail'), 'browse');
  assert.equal(capabilityOfTool('search_content'), 'browse');
  // P3-5：只读的资料/登录态查询归浏览——否则关掉浏览它们仍然可用。
  assert.equal(capabilityOfTool('get_user_profile'), 'browse');
  assert.equal(capabilityOfTool('check_login_status'), 'browse');
  assert.equal(capabilityOfTool('publish_content'), 'post');
  assert.equal(capabilityOfTool('publish_article'), 'post');
  assert.equal(capabilityOfTool('publish_video'), 'post');
  assert.equal(capabilityOfTool('post_comment'), 'comment');
  assert.equal(capabilityOfTool('reply_comment'), 'reply');
  // 登录写入类（改凭据）由更严格的凭据门禁管，不在这里重复映射。
  assert.equal(capabilityOfTool('interactive_login'), null);
  assert.equal(capabilityOfTool('get_login_qr_code'), null);
  assert.equal(capabilityOfTool('unknown_tool'), null);
  assert.equal(capabilityOfTool(123), null);
});

test('P2-3：巡逻时段按北京时间判定，与本机时区无关（含 TZ=UTC 子进程）', () => {
  // 固定 epoch：2026-10-30T07:30+08:00 = 2026-10-29T23:30Z
  const beijing0730 = Date.parse('2026-10-29T23:30:00Z');
  // 2026-10-30T00:30+08:00 = 2026-10-29T16:30Z
  const beijing0030 = Date.parse('2026-10-29T16:30:00Z');
  const daytime = { start: '07:00', end: '23:00' };
  assert.equal(beijingMinutesOfDay(beijing0730), 7 * 60 + 30, '换算必须落在北京 07:30');
  assert.equal(windowContains(daytime, beijing0730), true, '北京 07:30 必须在窗口内');
  assert.equal(windowContains(daytime, beijing0030), false, '北京 00:30 必须在窗口外');
  assert.equal(beijingMinutesOfDay('not-a-date'), null);

  // 子进程强制 TZ=UTC 再验一次：这是复审里暴露的真实偏差场景。
  const script = `
    import { windowContains, beijingMinutesOfDay } from ${JSON.stringify(pathToFileURL(settingsModulePath).href)};
    const ok = windowContains({ start: '07:00', end: '23:00' }, Date.parse('2026-10-29T23:30:00Z'));
    const minutes = beijingMinutesOfDay(Date.parse('2026-10-29T16:30:00Z'));
    process.stdout.write(JSON.stringify({ ok, minutes }));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, TZ: 'UTC' },
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { ok: true, minutes: 30 }, 'TZ=UTC 下也必须按北京时间判定');
});

test('读取：文件不存在⇒默认值；JSON 坏⇒fail-safe 只读模式；字段非法⇒fail-safe', () => {
  const dir = tempDir();
  const filePath = path.join(dir, 'settings.json');

  const missing = loadSettings({ filePath, fs });
  assert.equal(missing.ok, true);
  assert.equal(missing.created, false);
  assert.deepEqual(missing.settings.quota, { browse: 14, post: 2, comment: 12 });

  fs.writeFileSync(filePath, '{ not json', 'utf8');
  const corrupt = loadSettings({ filePath, fs });
  assert.equal(corrupt.ok, false);
  assert.equal(corrupt.reason, 'settings-corrupt');
  assert.equal(corrupt.settings.readOnly, true, '损坏必须 fail-safe 到只读模式');
  assert.equal(corrupt.settings.capabilities.browse, true, '读能力保持可用（不能因为配置坏了就全停）');

  fs.writeFileSync(filePath, JSON.stringify({ quota: { browse: 500 } }), 'utf8');
  const invalid = loadSettings({ filePath, fs });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, 'settings-invalid-quota-value');
  assert.equal(invalid.settings.readOnly, true);

  fs.writeFileSync(filePath, JSON.stringify({ quota: { browse: 3 }, readOnly: false }), 'utf8');
  const ok = loadSettings({ filePath, fs });
  assert.equal(ok.ok, true);
  assert.equal(ok.settings.quota.browse, 3);

  assert.deepEqual(failSafeSettings().readOnly, true);
});

test('保存：原子写（无 tmp 残留、文件内容完整）+ 非法配置不落盘', () => {
  const dir = tempDir();
  const filePath = path.join(dir, 'settings.json');
  const saved = saveSettings({ filePath, fs }, { quota: { browse: 7 }, readOnly: true });
  assert.equal(saved.ok, true);
  assert.equal(fs.existsSync(`${filePath}.tmp`), false, '不得留下临时文件');
  const disk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(disk.quota.browse, 7);
  assert.equal(disk.readOnly, true);
  assert.equal(disk.quota.post, 2, '未提供的键按默认值落盘，避免读回来时缺字段');

  const bad = saveSettings({ filePath, fs }, { quota: { browse: -5 } });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'invalid-quota-value');
  assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).quota.browse, 7, '非法输入不得覆盖已保存值');
});

test('巡逻投递判定：开关关闭先拒、时段外拒绝、时段内放行（含跨午夜与全天）', () => {
  const base = { patrol: { enabled: true, window: { start: '07:00', end: '23:00' } } };
  const at = (hhmm) => {
    const [hour, minute] = hhmm.split(':').map(Number);
    const d = new Date(2026, 9, 30, hour, minute, 0, 0);
    return d.getTime();
  };
  assert.deepEqual(decidePatrolDispatch(base, at('12:00')), { ok: true, reason: null }, '时段内必须放行');
  assert.equal(decidePatrolDispatch(base, at('06:59')).reason, 'console-outside-window', '早于起点必须拒绝');
  assert.equal(decidePatrolDispatch(base, at('23:00')).reason, 'console-outside-window', '终点是开区间');
  assert.equal(
    decidePatrolDispatch({ patrol: { enabled: false, window: base.patrol.window } }, at('12:00')).reason,
    'console-patrol-disabled',
    '开关关闭优先于时段（且不受时段影响）',
  );
  const overnight = { patrol: { enabled: true, window: { start: '22:00', end: '02:00' } } };
  assert.equal(decidePatrolDispatch(overnight, at('23:30')).ok, true, '跨午夜时段内必须放行');
  assert.equal(decidePatrolDispatch(overnight, at('01:00')).ok, true, '跨午夜凌晨侧必须放行');
  assert.equal(decidePatrolDispatch(overnight, at('03:00')).ok, false, '跨午夜之外必须拒绝');
  const allDay = { patrol: { enabled: true, window: { start: '00:00', end: '00:00' } } };
  assert.equal(decidePatrolDispatch(allDay, at('00:30')).ok, true, '全天窗口凌晨必须放行');
  assert.equal(decidePatrolDispatch(allDay, at('23:30')).ok, true, '全天窗口深夜必须放行');
  assert.equal(decidePatrolDispatch({}, at('12:00')).reason, 'console-patrol-disabled', '缺 patrol 必须按关闭');
  assert.equal(decidePatrolDispatch(null, at('12:00')).reason, 'console-patrol-disabled', 'null 必须按关闭');
});
