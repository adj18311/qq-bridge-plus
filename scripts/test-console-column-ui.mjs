// task-88：小黑盒专栏密码入口 UI 的静态契约测试。
// 页面行为（点击、fetch、Cookie）在真实浏览器里才有意义；这里只钉死结构、文案与安全不变量，
// 防止以后有人删掉某段提示、把密码写进 storage/URL，或引入语法错误。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'console.html'), 'utf8');

// 五段必须逐字存在的文案（task-88 任务卡 + lead 复核补充）。
const REQUIRED_COPY = [
  '属于敏感权限，请设置密码',
  '属于敏感权限，请验证密码',
  '密码是为了不让智能体自行修改',
  '重置密码前，请到「二代仿真」页点击「暂停二代 AI」，再重新设置密码',
  '修改未保存，确定退出吗？',
];

const ENDPOINTS = [
  '/api/console/xiaoheihe-column/auth/status',
  '/api/console/xiaoheihe-column/auth/setup',
  '/api/console/xiaoheihe-column/auth/verify',
  '/api/console/xiaoheihe-column/auth/logout',
  '/api/console/xiaoheihe-column/auth/forgot-reset',
];

const PASSWORD_INPUT_IDS = [
  'columnSetPassword',
  'columnSetConfirm',
  'columnVerifyPassword',
  'columnResetPassword',
  'columnResetConfirm',
];

function inputTag(id) {
  const match = html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`));
  return match === null ? null : match[0];
}

test('task88-1 导航项与 section 契约：data-view="xiaoheihe" 与 data-page="xiaoheihe"', () => {
  assert.match(html, /<button[^>]*data-view="xiaoheihe"/, '导航项缺少 data-view="xiaoheihe"');
  assert.match(html, /<section[^>]*id="section-xiaoheihe"[^>]*data-page="xiaoheihe"/, '缺少 data-page="xiaoheihe" 的 section');
  assert.ok(html.includes('小黑盒'), '导航/标题里必须有「小黑盒」');
});

test('task88-2 五段文案逐字存在（含「没有触发路径」的可见小字）', () => {
  for (const copy of REQUIRED_COPY) {
    assert.ok(html.includes(copy), `页面缺少文案：${copy}`);
  }
  // 阶段二已实现：原先「没有触发路径」的小字要求已失效，改为钉住真实的触发路径。
  assert.ok(!html.includes('没有触发路径'), '阶段二已实现，不应再声称没有触发路径');
  assert.ok(html.includes("保存并退出"), '缺少「保存并退出」按钮文案');
  // m35946：只保留顶部一个按钮（#columnLogout，文案「保存并退出」），点它先保存再退出。
  assert.ok(html.includes("logout.addEventListener('click', columnSaveAndExit)"), '保存并退出必须真的绑定到 columnSaveAndExit');
  assert.ok(!html.includes('id="columnSaveBtn"'), '底部重复的保存按钮必须删掉，只留顶部一个');
  assert.equal(html.split('<button id="columnLogout" class="small">保存并退出</button>').length - 1, 1, '页面必须恰好有一个「保存并退出」按钮');
});

test('task88-3 五个端点路径全部出现', () => {
  for (const endpoint of ENDPOINTS) {
    assert.ok(html.includes(endpoint), `页面缺少端点：${endpoint}`);
  }
});

test('task88-4 密码输入框全部是 type="password" 且 autocomplete=current-password', () => {
  for (const id of PASSWORD_INPUT_IDS) {
    const tag = inputTag(id);
    assert.ok(tag !== null, `缺少密码输入框 #${id}`);
    assert.match(tag, /type="password"/, `#${id} 必须是 type="password"`);
    assert.match(tag, /autocomplete="current-password"/, `#${id} 必须 autocomplete="current-password"`);
  }
});

test('task88-5 密码绝不写入 localStorage / sessionStorage / URL / 控制台日志', () => {
  assert.doesNotMatch(html, /localStorage\.[A-Za-z]*[Pp]assword/, 'localStorage 出现 password 相关写入');
  assert.doesNotMatch(html, /sessionStorage\.[A-Za-z]*[Pp]assword/, 'sessionStorage 出现 password 相关写入');
  assert.doesNotMatch(html, /localStorage\.setItem\([^)]*column/, 'localStorage 写入了专栏相关键');
  assert.doesNotMatch(html, /sessionStorage\.setItem\([^)]*column/, 'sessionStorage 写入了专栏相关键');
  assert.doesNotMatch(html, /location\.(hash|search|href)\s*=\s*[^;\n]*password/i, '密码被拼进 URL');
  assert.doesNotMatch(html, /console\.(log|error|warn|info)\([^)]*password/i, '密码被写进 console');
});

test('task88-6 同源 Cookie：专栏请求显式带 credentials: same-origin', () => {
  assert.match(html, /credentials\s*:\s*'same-origin'/, '缺少 credentials: same-origin（Path=/api/ 的会话 Cookie 才发得出去）');
});

test('task88-7 切到该 view 必须重新拉 status（不缓存会话有效性）', () => {
  assert.match(html, /if\s*\(\s*page\s*===\s*'xiaoheihe'[^\n]*refreshColumnStatus/, 'setConsolePage 未在进入专栏页时调用 refreshColumnStatus');
});

test('task88-8 门槛只看 socialV2（m30623）：setup 与 forgot-reset 同口径，巡逻状态仅展示', () => {
  // 2026-10-29 口径（m30623）：门槛只认 socialV2；巡逻状态只用于展示。
  assert.match(html, /const pausedSocial = agentPaused\.socialV2 === true;/, '缺少 socialV2 门槛变量');
  assert.match(html, /setupButton\.disabled = !pausedSocial;/, 'setup 门槛必须只看 socialV2');
  assert.match(html, /resetButton\.disabled = !pausedSocial;/, 'reset 门槛必须只看 socialV2');
  assert.doesNotMatch(html, /disabled = !pausedPatrol/, '不得再用巡逻状态做禁用判断（后台巡逻无法交互式暂停）');
  assert.match(html, /agentPaused\.backgroundPatrol/, '仍应如实展示后台巡逻状态');
  assert.match(html, /agentPaused\.socialV2/, '缺少 socialV2 门槛判断');
  assert.ok(html.includes('请先到「二代仿真」页点击「暂停二代 AI」'), '缺少实际门槛的禁用提示');
  assert.ok(html.includes('二代 AI 尚未暂停。请到「二代仿真」页点击「暂停二代 AI」；本次未做任何改动。'), '缺少实际门槛的拒绝文案');
});

test('task88-14 暂停状态必须轮询 + 回前台刷新（跨页暂停后按钮/文案要自己跟上）', () => {
  // 用户实测：在「二代仿真」页点了暂停，回到本页仍显示「运行中」且「设置」禁用。
  // 根因是状态只在进页时拉一次；这里钉住轮询与可见性刷新，防止再退化。
  assert.ok(html.includes('const COLUMN_STATUS_POLL_MS = 5000;'), '缺少暂停状态轮询间隔常量');
  assert.ok(html.includes('startColumnTick(); startColumnStatusPoll();'), '进页必须同时启动暂停状态轮询');
  assert.ok(html.includes('}, COLUMN_STATUS_POLL_MS);'), '轮询必须用 COLUMN_STATUS_POLL_MS');
  assert.ok(html.includes("if (currentConsolePage !== 'xiaoheihe' || document.hidden) return;"), '轮询必须在离页/后台标签页时跳过');
  assert.ok(html.includes('stopColumnStatusPoll();' + String.fromCharCode(10) + '    return;') || html.includes('stopColumnStatusPoll();' + String.fromCharCode(13, 10) + '    return;'), '页面隐藏时必须停表');
  assert.ok(html.includes('refreshColumnStatus();' + String.fromCharCode(10) + '    startColumnStatusPoll();') || html.includes('refreshColumnStatus();' + String.fromCharCode(13, 10) + '    startColumnStatusPoll();'), '回到前台必须立即刷新并重启轮询');
});
test('task88-15 专栏请求必须带 CSRF 纵深头（缺了它服务端 400，页面会永远显示运行中）', () => {
  // 用户实测：暂停后页面仍显示「二代仿真 运行中」、按钮禁用。根因不是缓存也不是门槛，
  // 是页面 api() 只发了 x-console-token/x-console-admin，专栏端点还要 x-column-request:1，直接 400。
  // 既有 HTTP 测试手动带了这个头，所以一直绿 —— 这里钉住**页面自己**必须带上它。
  assert.ok(html.includes("headers['x-column-request'] = '1';"), 'api() 必须给专栏端点加 x-column-request');
  assert.ok(html.includes("if (typeof path === 'string' && path.startsWith('/api/console/xiaoheihe-column/')) headers['x-column-request'] = '1';"), '只在专栏路径加头（避免污染其它接口）');
  assert.ok(html.includes('const data = await api(path, method, body, 0, { credentials: '), 'columnApi 必须复用 api()');
});
test('task88-9 untrusted 态从 status 直出并走忘记重设，不用「验证失败」误导文案', () => {
  assert.ok(html.includes('密码状态不可信'), '缺少 untrusted 提示文案');
  assert.match(html, /state\s*===\s*'untrusted'/, '渲染逻辑没有判断 untrusted 状态');
  assert.doesNotMatch(html, /验证失败[^。]*请重试/, '不得用「验证失败」误导 untrusted 用户');
});

test('task88-10 主 script 语法可解析（new Function）', () => {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  const main = scripts.sort((left, right) => right.length - left.length)[0];
  assert.ok(main && main.includes('COLUMN_STATUS_PATH'), '找不到包含专栏逻辑的主 script');
  assert.doesNotThrow(() => new Function(main), '主 script 存在语法错误');
});

test('task88-11 会话失效兜底：403 column-session-required 必须回到验证态（不依赖 expiresAt）', () => {
  assert.match(html, /data\.error === 'column-session-required'/, 'columnApi 未统一识别 403 column-session-required');
  assert.match(html, /function columnSessionLost\(\)/, '缺统一的会话失效处理函数');
  assert.match(html, /function columnSessionLost\(\)[\s\S]{0,240}columnVerifiedAt = 0/, 'columnSessionLost 未清空本地验证时刻');
  assert.match(html, /function columnSessionLost\(\)[\s\S]{0,400}renderColumnView\(\)/, 'columnSessionLost 未重新渲染回验证态');
});

// ── task88-12/13：主 script 必须能真正执行到底（TDZ 事故回归） ────────────────
// 2026-10-29 的真实事故：主 script 语法完全合法（task88-10 通过），但顶层
// `setConsolePage(...)` 已经调用到 `stopColumnTick()`，而 `let columnTickTimer` 的声明写在它
// 之后 ⇒ ReferenceError: Cannot access 'columnTickTimer' before initialization。顶层异常让整段
// 脚本中止，`refresh*()` 与 3 秒轮询再没执行过，所有面板永远停在 HTML 默认的「加载中…」。
// `new Function()` 只编译不执行，抓不到这类问题，所以这里必须用 VM 真跑一遍。
function domStub() {
  const seen = [];
  const elements = new Map();
  const makeEl = (tag = 'div') => {
    const listeners = new Map();
    const el = {
      tagName: String(tag).toUpperCase(), style: {}, dataset: {},
      classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
      children: [], value: '', checked: false, hidden: false,
      textContent: '', innerHTML: '', className: '',
      addEventListener(event, listener) { listeners.set(event, listener); }, setAttribute() {}, removeAttribute() {},
      getAttribute: () => null,
      appendChild(child) { el.children.push(child); return child; },
      insertBefore(child) { return child; }, removeChild() {}, remove() {},
      focus() {}, blur() {}, click() { listeners.get('click')?.({ target: el }); }, scrollIntoView() {},
      querySelector: () => makeEl(), querySelectorAll: () => [],
      closest: () => null, contains: () => false,
      getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }),
      getContext: () => new Proxy({}, { get: () => () => ({}) }),
      animate: () => ({ finished: Promise.resolve(), cancel() {} }),
    };
    return new Proxy(el, {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (prop === Symbol.toPrimitive || prop === 'then') return undefined;
        return () => undefined;
      },
      set(target, prop, value) { target[prop] = value; return true; },
      has: () => true,
    });
  };
  const document = {
    getElementById(id) { seen.push(id); if (!elements.has(id)) elements.set(id, makeEl()); return elements.get(id); },
    querySelector: () => makeEl(), querySelectorAll: () => [],
    createElement: (tag) => makeEl(tag),
    addEventListener() {}, body: makeEl('body'), documentElement: makeEl('html'),
    head: makeEl('head'), readyState: 'complete', title: '',
  };
  return { document, seen, elements };
}

function bootMainScript() {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  const main = scripts.sort((left, right) => right.length - left.length)[0];
  assert.ok(main && main.includes('COLUMN_STATUS_PATH'), '找不到包含专栏逻辑的主 script');
  const { document, seen, elements } = domStub();
  let intervals = 0;
  const sandbox = {
    document,
    navigator: { userAgent: 'console-ui-test', clipboard: { writeText: async () => {} } },
    location: { search: '', pathname: '/', hash: '', reload() {} },
    history: { replaceState() {}, pushState() {} },
    localStorage: {
      _v: new Map(),
      getItem(key) { return this._v.has(key) ? this._v.get(key) : null; },
      setItem(key, value) { this._v.set(key, String(value)); },
      removeItem(key) { this._v.delete(key); },
    },
    // 永不完结的 fetch：本用例只验证「脚本能跑到底」，不验证网络路径、不碰真实凭据。
    fetch: () => new Promise(() => {}),
    prompt: () => null, alert() {}, confirm: () => false,
    setInterval() { intervals += 1; return intervals; }, clearInterval() {},
    setTimeout: () => 0, clearTimeout() {},
    console, JSON, Date, Math, Number, String, Boolean, Array, Object, Promise, Error,
    RegExp, Map, Set, isNaN, parseInt, parseFloat, URLSearchParams,
    encodeURIComponent, decodeURIComponent,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.addEventListener = () => {};
  sandbox.removeEventListener = () => {};
  sandbox.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  sandbox.innerWidth = 1280;
  sandbox.innerHeight = 800;
  sandbox.scrollTo = () => {};
  sandbox.getComputedStyle = () => ({ getPropertyValue: () => '' });
  sandbox.requestAnimationFrame = (fn) => { try { fn(0); } catch { /* ignore */ } return 0; };
  sandbox.cancelAnimationFrame = () => {};
  sandbox.Chart = function Chart() { return { destroy() {}, update() {}, resize() {} }; };
  sandbox.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
  sandbox.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  sandbox.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  let error = null;
  try {
    vm.runInNewContext(main, sandbox, { filename: 'console-inline.js', timeout: 10000 });
  } catch (caught) {
    error = caught;
  }
  return { error, intervals, seen, elements, sandbox };
}

test('忘记密码输入框在状态轮询后保持打开及保留输入', async () => {
  const { error, elements, sandbox } = bootMainScript();
  assert.equal(error, null);
  sandbox.columnApi = async () => ({ state: 'set', session: { valid: false }, agentPaused: { socialV2: true } });
  await sandbox.refreshColumnStatus();
  elements.get('columnForgotOpen').click();
  assert.equal(elements.get('columnForgot').hidden, false, '点击后必须显示重设区域');
  const input = sandbox.document.getElementById('columnResetPassword');
  input.value = 'offline-test-draft';
  await sandbox.refreshColumnStatus();
  assert.equal(elements.get('columnForgot').hidden, false, '状态轮询不得关闭重设区域');
  assert.equal(input.value, 'offline-test-draft', '轮询不得丢失输入');
});

test('task88-12 主 script 顶层执行不得抛异常（TDZ 回归：否则所有面板停在「加载中…」）', () => {
  const { error, intervals, seen } = bootMainScript();
  assert.equal(error, null, `主 script 顶层抛异常，整段脚本会中止：${error?.message || error}`);
  assert.ok(intervals >= 1, '脚本没有执行到顶层 setInterval：启动调用被异常打断（3 秒轮询不会建立）');
  assert.ok(seen.length > 60, `启动阶段 getElementById 次数过低（${seen.length}），疑似提前中止`);
});

test('task88-13 静态 pin：column* 状态声明必须早于顶层 setConsolePage 调用（TDZ 防线）', () => {
  const declIndex = html.indexOf('let columnTickTimer = null;');
  const callIndex = html.indexOf('setConsolePage(location.hash.slice(1)');
  assert.ok(declIndex > 0, '缺少 columnTickTimer 声明');
  assert.ok(callIndex > 0, '缺少顶层 setConsolePage 调用');
  assert.ok(declIndex < callIndex, '`let columnTickTimer` 声明位于顶层 setConsolePage 之后 ⇒ TDZ');
  assert.equal(html.split('let columnTickTimer = null;').length - 1, 1, 'columnTickTimer 重复声明');
});

test('task88-16 设置面板契约：四能力开关 / 只读 / 巡逻时段 / 三额度(0-99) / 保存并退出 / 审计表格 / 底部红字', () => {
  const ids = [
    'columnSettingsPanel', 'columnSettingsCaps', 'columnReadOnly', 'columnPatrolEnabled',
    'columnPatrolStart', 'columnPatrolEnd', 'columnQuotaBrowse', 'columnQuotaPost', 'columnQuotaComment',
    'columnSettingsActions', 'columnSettingsReload', 'columnSaveMsg', 'columnSaveSteps',
    'columnQuotaLive', 'columnAuditRefresh', 'columnAuditMsg', 'columnAuditTable',
  ];
  for (const id of ids) {
    assert.equal(html.split(`id="${id}"`).length - 1, 1, `缺少唯一元素 #${id}`);
  }
  // m35946：保存与退出合并到顶部按钮，底部不再有独立的保存按钮。
  assert.equal(html.split('id="columnSaveBtn"').length - 1, 0, '#columnSaveBtn 必须已移除');
  // 退出请求必须带 JSON body：api() 只在 body 为真时设 content-type，
  // 缺了它会被服务端全局 CSRF 判 415，页面就会一直显示「退出失败，请重试」。
  assert.ok(html.includes("columnApi(COLUMN_LOGOUT_PATH, 'POST', {})"), '退出请求必须带空 JSON body（否则 415）');
  assert.equal(html.split('min="0" max="99"').length - 1, 3, '三个额度输入必须是 0..99');
  assert.match(html, /<input type="time" id="columnPatrolStart"/, '巡逻起始时间必须是 time 输入');
  assert.match(html, /<input type="time" id="columnPatrolEnd"/, '巡逻结束时间必须是 time 输入');
  assert.ok(html.includes('密码是为了不让智能体自行修改'), '缺少底部红字提示');
  const panel = html.slice(html.indexOf('id="columnSettingsPanel"'));
  assert.ok(panel.length > 0, '设置面板不存在');
});

test('task88-17 保存并退出：端点、变更清单确认、失败即停展示、未保存拦截', () => {
  for (const p of ['/api/console/xiaoheihe-column/settings', '/api/console/xiaoheihe-column/settings/apply', '/api/console/xiaoheihe-column/audit']) {
    assert.ok(html.includes(p), `缺少端点 ${p}`);
  }
  assert.ok(html.includes('async function columnSaveAndExit'), '缺少 columnSaveAndExit');
  assert.ok(html.includes("{ settings: settings, actions: actions }"), 'apply 请求体必须同时带 settings 与 actions');
  assert.ok(html.includes('保存配置 → 下发额度 → 重置额度 → 恢复'), '确认框必须写明执行顺序');
  assert.ok(html.includes('一步失败立即停止，不回滚'), '确认框必须写明失败即停不回滚');
  assert.ok(html.includes('function columnSaveStepsRender'), '缺少执行步骤回执渲染');
  assert.ok(html.includes("window.addEventListener('beforeunload'"), '缺少关闭页面拦截（beforeunload）');
  assert.ok(html.includes('columnSettingsHasUnsaved'), '缺少未保存判定');
  assert.ok(html.includes('修改未保存，确定退出吗？'), '缺少离开本页的二次确认');
  assert.equal(html.split("window.addEventListener('beforeunload").length - 1, 1, 'beforeunload 重复注册');
});

test('task88-19 设置面板：非法输入当场报错、动作计入未保存、保存后清空动作、部分失败文案区分已生效', () => {
  // P2-2：非法数字/时间不能静默回退成默认值。
  assert.ok(html.includes('function columnSettingsProblems()'), '必须有输入校验函数');
  assert.ok(html.includes("problems.push(item[1] + '必须是 0–99 的整数')"), '额度必须校验 0–99');
  assert.ok(html.includes("if (problems.length > 0) { columnSettingsMsg('输入无效，未保存：'"), '保存前必须先校验并拒绝发送');
  assert.ok(html.includes("if (problems.length > 0) { columnSettingsMsg('输入无效：'"), '输入时就要提示');
  // P2-2：勾选附加动作也算「未保存」——否则离开页面不会询问。
  assert.ok(html.includes("const actionsNow = columnSettingsActionSignature();"), 'dirty 必须把动作算进来');
  assert.ok(html.includes("columnSettingsDirty = now !== before || actionsNow !== '';"), 'dirty 判定必须同时看配置与动作');
  // P3-1：保存成功后清空动作勾选，防止重复重置/恢复。
  assert.ok(html.includes('function columnSettingsClearActions()'), '必须有清空动作的函数');
  assert.ok(html.includes('columnSettingsClearActions();'), '保存成功后必须调用清空动作');
  // P2-4：部分失败要区分「配置已生效」与「额度未完成」。
  assert.ok(html.includes("const prefix = savedOk ? '配置已保存并生效，但'"), '部分失败文案必须区分已生效部分');
  assert.ok(html.includes('再点一次「保存并退出」只会重试未完成的部分'), '部分失败要告诉用户可以重试');
});

test('task88-20 巡逻时段校验用的是真 HH:MM 正则（回归：反斜杠被吃成 /^d{2}:d{2}$/ 导致永远保存失败）', () => {
  // 2026-10-30 的真实事故：5cde9ee 引入的 `/^d{2}:d{2}$/` 少了反斜杠，
  // 正则变成「字母 d 恰好两次」，任何 07:00 都不匹配 ⇒ 保存被前端永久拦下。
  // 静态 pin 只能保证字面量存在，所以这里把正则抠出来做行为断言。
  assert.ok(!html.includes('/^d{2}:d{2}$/'), '不得出现被吃掉转义的 /^d{2}:d{2}$/');
  const matched = html.match(/const timeRe = (\/\^[^\n]*?\/);/);
  assert.ok(matched, '必须能找到 const timeRe = /…/; 定义');
  const timeRe = eval(matched[1]); // eslint-disable-line no-eval
  assert.ok(timeRe.test('07:00'), '合法值 07:00 必须通过，实际不通过');
  assert.ok(timeRe.test('00:00') && timeRe.test('23:59'), '边界值必须通过');
  assert.ok(!timeRe.test('7:00'), '7:00 必须被拒（要求两位小时）');
  assert.ok(!timeRe.test('0700'), '0700 必须被拒（缺冒号）');
  assert.ok(!timeRe.test('07:00 '), '带尾随空格的原始值必须被拒（调用方先 trim）');
  // 另一处同值校验（回填兜底）也必须是真的 \d。
  assert.ok(html.includes('return /^\\d{2}:\\d{2}$/.test(value) ? value : fallback;'), '回填兜底的正则也必须是 \\d');
});

test('task88-21 身份守卫恢复入口：走 /api/identity-guard/recover、带空 JSON body、不在前端复算前置条件', () => {
  // 1) 端点常量必须是守卫那个，不能错拿降级层的 /api/degrade/recover。
  assert.ok(html.includes("const COLUMN_GUARD_RECOVER_PATH = '/api/identity-guard/recover'"), '缺少身份守卫恢复端点常量');
  // 2) 面板与按钮必须唯一存在（否则用户界面上根本找不到入口 —— 这正是它曾长期缺席的表现）。
  for (const id of ['columnGuardPanel', 'columnGuardState', 'columnGuardRecover', 'columnGuardMsg', 'columnGuardFailed']) {
    assert.equal(html.split(`id="${id}"`).length - 1, 1, `缺少唯一元素 #${id}`);
  }
  // 3) 按钮必须真的绑到恢复函数上（只画按钮不绑事件同样点不动）。
  assert.ok(html.includes("guardRecover.addEventListener('click', columnGuardRunRecover)"), '按钮未绑定 columnGuardRunRecover');
  assert.ok(html.includes('async function columnGuardRunRecover'), '缺少 columnGuardRunRecover');
  // 4) 恢复请求必须带空 JSON body：api() 只在 body 为真时设 content-type，
  //    缺了它会被服务端全局 CSRF 判 415（与「保存并退出」同一个坑）。
  assert.ok(html.includes("columnApi(COLUMN_GUARD_RECOVER_PATH, 'POST', {})"), '恢复请求必须带空 JSON body（否则 415）');
  // 5) 面板显隐跟随专栏会话：未验证时拉了也是 403，不能空轮询。
  assert.ok(html.includes("columnShow('columnGuardPanel', verified)"), '守卫面板显隐必须跟随专栏会话');
  // 6) 前端不得复算三个前置条件（用户口径 m49780：不要重复加防护）。
  //    只允许展示服务端返回的 failed/messages，不允许自己拼判定。
  const guardSlice = html.slice(html.indexOf('function renderColumnGuard'));
  assert.ok(guardSlice.length > 0, '缺少 renderColumnGuard');
  assert.ok(!guardSlice.includes('canRecover'), '守卫面板不得引用降级层的 canRecover');
  for (const banned of ['identityOk:', 'qqCommsOk:', 'reportDelivered:']) {
    assert.ok(!guardSlice.includes(banned), `恢复请求不得夹带本地判定 ${banned}`);
  }
  // 7) 读的必须是 /api/status 的 identityGuard 段（该字段一直只读暴露，不新增接口）。
  assert.ok(html.includes('status.identityGuard'), '守卫状态必须取自 /api/status 的 identityGuard');
  // 8) 状态文案要区分「全部暂停」与「仅写入暂停」——两者影响面差一个数量级。
  assert.ok(html.includes("state === 'all-paused'"), '必须区分 all-paused');
  assert.ok(html.includes("state === 'restricted'"), '必须区分 restricted');
  // 9) 拒绝时必须展示服务端原话，不能只说「失败」。
  assert.ok(guardSlice.includes('result.messages'), '拒绝时必须展示服务端 messages');
  assert.ok(guardSlice.includes('result.failed'), '拒绝时必须展示服务端 failed');
  // 10) 面板必须带初始 hidden：它与 #columnDegradePanel / #columnSettingsPanel 同级，
  //     那两个都是 hidden 的（未验证专栏会话时拉也是 403）。少了它，页面一打开
  //     就把守卫面板露出来，点下去必然收到 column-session-required。
  assert.ok(
    /<div id="columnGuardPanel"[^>]*\shidden[\s>]/.test(html),
    '守卫面板必须带初始 hidden（与降级/配置面板一致）',
  );
  // 11) 守卫面板的报错不得借用降级面板的消息位：columnDegradeMsg 写的是
  //     #columnDegradeMsg，而守卫与降级是两套独立机制，降级面板此时可能隐藏。
  assert.ok(!guardSlice.includes('columnDegradeMsg('), '守卫面板不得把错误写进降级面板的消息位');
});

test('task88-18 页面不做本地权限判断：配置合法性/顺序/生效与否一律以服务端回执为准', () => {
  assert.ok(html.includes('const COLUMN_SETTINGS_PATH'), '缺少配置读取端点常量');
  assert.ok(html.includes('const COLUMN_SETTINGS_APPLY_PATH'), '缺少保存端点常量');
  assert.ok(html.includes('const COLUMN_AUDIT_PATH'), '缺少审计端点常量');
  assert.ok(html.includes('function renderColumnSettings'), '缺少配置回填');
  assert.ok(html.includes('已保存并生效。'), '成功文案必须来自服务端 ok:true 分支');
  assert.ok(html.includes('保存未完成：'), '失败文案必须带服务端 failed 原因');
  // 页面不得自己推断暂停状态或权限（那会绕过服务端判定）。
  assert.ok(!html.includes('columnSettingsDecide'), '页面不应实现权限判定函数');
});
