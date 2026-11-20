import assert from 'node:assert/strict';
import { buildQzoneOnebotReadRequest } from '../src/core/qzone-onebot-contract-offline.mjs';

function rejects(input, pattern, action = 'get_qzone_msg_list') {
  assert.throws(() => buildQzoneOnebotReadRequest(action, input), pattern);
}

assert.deepEqual(
  buildQzoneOnebotReadRequest('get_qzone_msg_list', { target_uin: '9876543210' }),
  {
    action: 'get_qzone_msg_list',
    params: { target_uin: 9876543210, pos: 0, num: 20 }
  }
);

assert.deepEqual(
  buildQzoneOnebotReadRequest('get_qzone_msg_list', { target_uin: 12345, pos: 7, num: 3 }),
  {
    action: 'get_qzone_msg_list',
    params: { target_uin: 12345, pos: 7, num: 3 }
  }
);

assert.deepEqual(
  buildQzoneOnebotReadRequest('get_qzone_msg_detail', {
    tid: 'post-1',
    target_uin: '12345'
  }),
  {
    action: 'get_qzone_msg_detail',
    params: { tid: 'post-1', target_uin: 12345, pos: 0, num: 20 }
  }
);

assert.equal(
  buildQzoneOnebotReadRequest('get_qzone_msg_detail', {
    tid: `A_${'x'.repeat(126)}`,
    target_uin: 12345
  }).params.tid.length,
  128
);

assert.deepEqual(
  Object.keys(buildQzoneOnebotReadRequest('get_qzone_msg_list', { target_uin: 1 })).sort(),
  ['action', 'params']
);

for (const target_uin of [undefined, null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '0', '00123', '1e3', ' 123', '9007199254740992']) {
  rejects({ target_uin }, /target_uin/);
}

for (const [pos, num] of [[-1, 1], [1.5, 1], [0, 0], [0, 101], [0, '1']]) {
  rejects({ target_uin: 12345, pos, num }, /pos|num/);
}

for (const tid of ['', 'has space', 'a.b', 'x'.repeat(129)]) {
  rejects({ tid, target_uin: 12345 }, /tid/, 'get_qzone_msg_detail');
}

rejects({ target_uin: 12345, token: 'secret' }, /unknown|extra|field/);
rejects({ target_uin: 12345, action: 'send_qzone_msg' }, /unknown|extra|field/);
let getterCalled = false;
const accessorInput = Object.defineProperty({ target_uin: 12345 }, 'pos', {
  get() {
    getterCalled = true;
    return 0;
  }
});
rejects(accessorInput, /accessor|data property/);
assert.equal(getterCalled, false);
assert.throws(() => buildQzoneOnebotReadRequest('send_qzone_msg', { content: 'x' }), /action/);
assert.throws(() => buildQzoneOnebotReadRequest('get_qzone_msg_detail', { tid: '1127000000f1536501000000' }), /target_uin/);

console.log('qzone-onebot-contract-offline: all assertions passed');
