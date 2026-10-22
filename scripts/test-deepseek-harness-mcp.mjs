import { NodeApiClient, unwrap } from '../src/dsh-client.js';

const baseUrl = (process.env.DSH_BASE_URL || 'http://127.0.0.1:19387').replace(/\/+$/, '');
const api = new NodeApiClient(baseUrl, 30_000, { tokenExplicit: false });

let pass = 0;
let fail = 0;

function check(label, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`OK   ${label}${detail ? ' — ' + detail : ''}`);
  } else {
    fail += 1;
    console.log(`FAIL ${label}${detail ? ' — ' + detail : ''}`);
  }
}

try {
  const settings = unwrap(await api.callUnary('settings.describe', {}), 'settings.describe');
  check('DeepSeek Harness Web API 可鉴权访问', settings && typeof settings === 'object', baseUrl);

  const presets = unwrap(await api.callUnary('agentPresets.list', {}), 'agentPresets.list');
  const ids = (presets.presets ?? []).map((p) => p.id);
  check('agent preset 列表可读取', ids.length > 0, ids.join(', '));

  const sessions = unwrap(await api.callUnary('session.list', {}), 'session.list');
  check('session/list 可读取', Array.isArray(sessions.items), `${sessions.items?.length ?? 0} sessions`);
} catch (error) {
  fail += 1;
  console.error('FAIL DeepSeek Harness MCP 前置探测失败:', error?.message ?? error);
}

console.log(`\n总计: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
