// t41：界内读取传输支持 `get_qzone_msg_detail`（tid）。
//
// 这个测试只证明**传输绑定层**的形状与拒绝语义：
//   · 不传 action ⇒ 仍走 list（C1 以来的形状逐字节不变）；
//   · action: 'get_qzone_msg_detail' + 合法 tid ⇒ 调 detail 方法并收到 {tid,target_uin,pos,num}；
//   · 一切在发出之前被拒的情况都必须带 not-sent 标记（否则会白烧 trackingLimit 名额）。
//
// 零真实 QQ 请求：这里所有 `transport` 都是假的，只记录被调用的方法名与参数。
// 运行：node --test scripts/test-qzone-bound-read-transport-detail.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createQzoneBoundReadTransport,
  isQzoneReadNotSent,
} from '../src/core/qzone-bound-read-transport.mjs';

const BOT = 123;
const EPOCH = 7;
const ENVELOPE = { status: 'ok', retcode: 0, data: { tid: 'post-1', comments: [] } };

/** 一个假 transport：记录每次调用的方法名与参数，绝不发任何请求。 */
function makeTransport({ withDetail = true } = {}) {
  const calls = [];
  const transport = {
    async get_qzone_msg_list(params) {
      calls.push(['get_qzone_msg_list', params]);
      return { kind: 'trusted-envelope', envelope: { status: 'ok', retcode: 0, data: { msglist: [] } } };
    },
  };
  if (withDetail) {
    transport.get_qzone_msg_detail = async (params) => {
      calls.push(['get_qzone_msg_detail', params]);
      return { kind: 'trusted-envelope', envelope: ENVELOPE };
    };
  }
  return { transport, calls };
}

const listInput = () => ({ target_uin: 456, pos: 0, num: 20, botQq: BOT, connectionEpoch: EPOCH, sourceProofId: 'proof-1' });
const detailInput = () => ({
  action: 'get_qzone_msg_detail', tid: 'post-1', target_uin: 456, pos: 0, num: 20,
  botQq: BOT, connectionEpoch: EPOCH, sourceProofId: 'proof-1',
});

/** 断言某次调用**在发出之前**被拒：必须抛错且带 not-sent 标记。 */
async function assertNotSent(promise, label) {
  let thrown;
  try { await promise; } catch (error) { thrown = error; }
  assert.ok(thrown instanceof Error, label + '：必须抛错');
  assert.equal(isQzoneReadNotSent(thrown), true, label + '：必须带 not-sent 标记（否则会白烧 trackingLimit）');
}

test('1. 不传 action ⇒ 仍走 list，detail 方法一次都不被调用', async () => {
  const { transport, calls } = makeTransport();
  const read = createQzoneBoundReadTransport({ botQq: BOT, getConnectionEpoch: () => EPOCH, transport });
  const envelope = await read(listInput(), () => true);
  assert.deepEqual(envelope, { status: 'ok', retcode: 0, data: { msglist: [] } }, 'list 的信封必须原样返回');
  assert.deepEqual(calls, [['get_qzone_msg_list', { target_uin: 456, pos: 0, num: 20 }]],
    '必须恰好调用一次 get_qzone_msg_list，参数逐字来自契约');
  assert.equal(calls.some(([name]) => name === 'get_qzone_msg_detail'), false, 'detail 不得被调用');
});

test('2. action=get_qzone_msg_detail + 合法 tid ⇒ 调 detail，且收到 {tid,target_uin,pos,num}', async () => {
  const { transport, calls } = makeTransport();
  const read = createQzoneBoundReadTransport({ botQq: BOT, getConnectionEpoch: () => EPOCH, transport });
  const envelope = await read(detailInput(), () => true);
  assert.deepEqual(envelope, ENVELOPE, 'detail 的信封必须原样返回');
  assert.equal(calls.length, 1, '恰好一次调用');
  assert.equal(calls[0][0], 'get_qzone_msg_detail', '必须调 detail 方法');
  assert.deepEqual(calls[0][1], { tid: 'post-1', target_uin: 456, pos: 0, num: 20 },
    '参数必须恰好是 {tid,target_uin,pos,num}（顺序与 SnowLuma 定义一致，且不含 action）');
});

test('2b. 显式写 action=get_qzone_msg_list ⇒ 与不传 action 等价（仍走 list）', async () => {
  const { transport, calls } = makeTransport();
  const read = createQzoneBoundReadTransport({ botQq: BOT, getConnectionEpoch: () => EPOCH, transport });
  const envelope = await read({ ...listInput(), action: 'get_qzone_msg_list' }, () => true);
  assert.equal(envelope.status, 'ok');
  assert.deepEqual(calls.map(([name]) => name), ['get_qzone_msg_list'], '显式 list 仍走 list');
  assert.deepEqual(calls[0][1], { target_uin: 456, pos: 0, num: 20 }, '参数与隐式 list 完全一致');
});

test('3. 非法 tid（空 / 超 128 / 含点 / 含斜杠 / 非字符串 / 含空格）⇒ not-sent，且零调用', async () => {
  const bad = ['', 'a'.repeat(129), 'post.1', 'post/1', 123, 'post 1', ' post', 'пост'];
  for (const tid of bad) {
    const { transport, calls } = makeTransport();
    const read = createQzoneBoundReadTransport({ botQq: BOT, getConnectionEpoch: () => EPOCH, transport });
    await assertNotSent(read({ ...detailInput(), tid }, () => true), 'tid=' + JSON.stringify(tid));
    assert.equal(calls.length, 0, 'tid 非法时不得调用任何 transport 方法（tid=' + JSON.stringify(tid) + '）');
  }
});

test('3b. 合法 tid 的边界：1 字符与 128 字符都要放行', async () => {
  for (const tid of ['a', 'a'.repeat(128), 'A-z_0-9']) {
    const { transport, calls } = makeTransport();
    const read = createQzoneBoundReadTransport({ botQq: BOT, getConnectionEpoch: () => EPOCH, transport });
    await read({ ...detailInput(), tid }, () => true);
    assert.deepEqual(calls[0][1], { tid, target_uin: 456, pos: 0, num: 20 }, 'tid=' + tid + ' 必须原样透传');
  }
});

test('4. 未知 action（含写动作）⇒ not-sent，且零调用', async () => {
  const bad = ['get_qzone_msg_list_x', 'send_qzone_msg', 'comment_qzone', 'like_qzone', '', 'GET_QZONE_MSG_DETAIL'];
  for (const action of bad) {
    const { transport, calls } = makeTransport();
    const read = createQzoneBoundReadTransport({ botQq: BOT, getConnectionEpoch: () => EPOCH, transport });
    await assertNotSent(read({ ...detailInput(), action }, () => true), 'action=' + JSON.stringify(action));
    assert.equal(calls.length, 0, '未知 action 时不得调用 transport（action=' + JSON.stringify(action) + '）');
  }
});

test('5. 字段多一个 / 少一个 ⇒ not-sent（两种形状都测）', async () => {
  // detail 形状
  {
    const { transport, calls } = makeTransport();
    const read = createQzoneBoundReadTransport({ botQq: BOT, getConnectionEpoch: () => EPOCH, transport });
    await assertNotSent(read({ ...detailInput(), extra: 1 }, () => true), 'detail 多一个字段');
    const missing = detailInput();
    delete missing.tid;
    await assertNotSent(read(missing, () => true), 'detail 少 tid');
    const missing2 = detailInput();
    delete missing2.sourceProofId;
    await assertNotSent(read(missing2, () => true), 'detail 少 sourceProofId');
    assert.equal(calls.length, 0, '字段集不对时不得调用 transport');
  }
  // list 形状
  {
    const { transport, calls } = makeTransport();
    const read = createQzoneBoundReadTransport({ botQq: BOT, getConnectionEpoch: () => EPOCH, transport });
    await assertNotSent(read({ ...listInput(), extra: 1 }, () => true), 'list 多一个字段');
    const missing = listInput();
    delete missing.num;
    await assertNotSent(read(missing, () => true), 'list 少 num');
    await assertNotSent(read({ ...listInput(), tid: 'post-1' }, () => true), 'list 形状里塞 tid');
    assert.equal(calls.length, 0, '字段集不对时不得调用 transport');
  }
});

test('5b. action: undefined（键在但值不是合法动作）⇒ not-sent，不得被当成 list 放行', async () => {
  const { transport, calls } = makeTransport();
  const read = createQzoneBoundReadTransport({ botQq: BOT, getConnectionEpoch: () => EPOCH, transport });
  await assertNotSent(read({ ...listInput(), action: undefined }, () => true), 'action: undefined');
  assert.equal(calls.length, 0);
});

test('6. epoch 不匹配 ⇒ not-sent（两种动作都要回归）', async () => {
  // list
  {
    const { transport, calls } = makeTransport();
    const read = createQzoneBoundReadTransport({ botQq: BOT, getConnectionEpoch: () => 8, transport });
    await assertNotSent(read(listInput(), () => true), 'list epoch 不匹配');
    assert.equal(calls.length, 0);
  }
  // detail
  {
    const { transport, calls } = makeTransport();
    const read = createQzoneBoundReadTransport({ botQq: BOT, getConnectionEpoch: () => 8, transport });
    await assertNotSent(read(detailInput(), () => true), 'detail epoch 不匹配');
    assert.equal(calls.length, 0);
  }
  // 返回前代际变了 ⇒ 必须抛**普通**错误（后果未知，不能声称 not-sent）
  {
    let epoch = EPOCH;
    const transport = {
      async get_qzone_msg_list() { return { kind: 'trusted-envelope', envelope: {} }; },
      async get_qzone_msg_detail() { epoch = 8; return { kind: 'trusted-envelope', envelope: ENVELOPE }; },
    };
    const read = createQzoneBoundReadTransport({ botQq: BOT, getConnectionEpoch: () => epoch, transport });
    let thrown;
    try { await read(detailInput(), () => true); } catch (error) { thrown = error; }
    assert.ok(thrown instanceof Error, '返回前代际变化必须抛错');
    assert.equal(isQzoneReadNotSent(thrown), false,
      '已经发出去了的失败不得标 not-sent —— 那会变成不扣额度的读取');
  }
});

test('7. 缺 get_qzone_msg_detail 方法：detail 读 not-sent（零额度），list 读照常可用', async () => {
  const { transport, calls } = makeTransport({ withDetail: false });
  const read = createQzoneBoundReadTransport({ botQq: BOT, getConnectionEpoch: () => EPOCH, transport });
  await assertNotSent(read(detailInput(), () => true), '缺 detail 方法');
  assert.equal(calls.length, 0, '缺方法时不得调用任何东西');
  // 关键：list 不受牵连（这正是选择「延迟检查」而不是「构造时要求两个方法」的理由）
  const envelope = await read(listInput(), () => true);
  assert.equal(envelope.status, 'ok', 'list 读必须仍然可用');
  assert.deepEqual(calls.map(([name]) => name), ['get_qzone_msg_list']);
});

test('8. envelope 校验对两个动作一致：不是 trusted-envelope ⇒ 抛错且不带 not-sent', async () => {
  for (const action of ['list', 'detail']) {
    const transport = {
      async get_qzone_msg_list() { return { status: 'ok' }; },
      async get_qzone_msg_detail() { return { kind: 'untrusted' }; },
    };
    const read = createQzoneBoundReadTransport({ botQq: BOT, getConnectionEpoch: () => EPOCH, transport });
    const input = action === 'list' ? listInput() : detailInput();
    let thrown;
    try { await read(input, () => true); } catch (error) { thrown = error; }
    assert.ok(thrown instanceof Error, action + '：未经信任的信封必须抛错');
    assert.equal(isQzoneReadNotSent(thrown), false,
      action + '：请求已发出，不得标 not-sent（两个动作口径必须一致）');
  }
});

test('9. 形状交叉校验：键数对但字段名错位、或字段集与动作不自洽 ⇒ not-sent', async () => {
  const base = listInput();
  const cases = [
    ['8 键但 tid 被换成未知字段', { ...base, action: 'get_qzone_msg_detail', foo: 'x' }],
    ['7 键 action=detail 但缺 tid', { ...base, action: 'get_qzone_msg_detail' }],
    ['7 键 action=list 但混入 tid', { ...base, action: 'get_qzone_msg_list', tid: 'post-1' }],
    ['6 键无 action 但混入 tid', { ...base, tid: 'post-1' }],
    ['9 键（多到没有任何闭集匹配）', { ...base, action: 'get_qzone_msg_detail', tid: 'p', extra: 1 }],
  ];
  for (const [label, input] of cases) {
    const { transport, calls } = makeTransport();
    const read = createQzoneBoundReadTransport({ botQq: BOT, getConnectionEpoch: () => EPOCH, transport });
    await assertNotSent(read(input, () => true), label);
    assert.equal(calls.length, 0, label + '：不得调用 transport');
  }
});

test('10. 目标侧参数仍由契约裁定：非法 target_uin / num ⇒ not-sent（不得冒成未知结果）', async () => {
  const bads = [
    ['target_uin=0', { ...detailInput(), target_uin: 0 }],
    ['target_uin=字符串前导零', { ...detailInput(), target_uin: '007' }],
    ['num=0', { ...detailInput(), num: 0 }],
    ['num=101', { ...detailInput(), num: 101 }],
    ['pos=-1', { ...detailInput(), pos: -1 }],
  ];
  for (const [label, input] of bads) {
    const { transport, calls } = makeTransport();
    const read = createQzoneBoundReadTransport({ botQq: BOT, getConnectionEpoch: () => EPOCH, transport });
    await assertNotSent(read(input, () => true), label);
    assert.equal(calls.length, 0, label + '：不得调用 transport');
  }
});

test('11. 非纯对象 / 数组 / 带 getter 的输入 ⇒ not-sent', async () => {
  const { transport, calls } = makeTransport();
  const read = createQzoneBoundReadTransport({ botQq: BOT, getConnectionEpoch: () => EPOCH, transport });
  await assertNotSent(read(null, () => true), 'null');
  await assertNotSent(read([], () => true), '数组');
  const withGetter = detailInput();
  Object.defineProperty(withGetter, 'tid', { get: () => 'post-1', enumerable: true });
  await assertNotSent(read(withGetter, () => true), 'getter 字段');
  assert.equal(calls.length, 0);
});
