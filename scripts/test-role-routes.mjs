// Offline tests for the six role-management routes extracted from bridge.js.
//
// Fresh system-temp role files only (never production roles/state), an in-memory
// roleState, and a request context that records JSON responses/body reads/logs.
// A frozen literal copy of the original six blocks (scripts/fixtures/role-routes-baseline.mjs)
// runs over an identical fresh fixture, so the moved controller is compared with
// pre-extraction behavior rather than with itself.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ROLE_CONTENT_MAX_BYTES, ROLE_NAME_MAX, createRoleStore } from '../src/core/role-store.mjs';
import { roleCharStats } from '../src/role-card.js';
import { createBaselineRoleRoutes } from './fixtures/role-routes-baseline.mjs';
import { createRoleRoutes } from '../src/console/role-routes.mjs';

const CARD = ['# 通用', '', '你好', '', '## 一代 〔一代〕', '', '[SILENT] 空格分隔', '', '## 二代 〔二代〕', '', '工具发言'].join('\n');
const UPDATED = CARD + '\n\n appended';
const STORED = UPDATED + '\n';
const LIMIT = roleCharStats(STORED).v2 - 1;
const DEFAULT_LIMIT = 6000;

function createHarness(factory, seed = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-role-routes-'));
  const rolesDir = path.join(root, 'roles');
  fs.mkdirSync(rolesDir, { recursive: true });
  for (const [name, content] of Object.entries(seed)) fs.writeFileSync(path.join(rolesDir, name + '.md'), content, 'utf8');
  let injectLimit = DEFAULT_LIMIT;
  const state = { role: null, mode: 'active' };
  const logs = [];
  const calls = { readState: 0, writeState: 0, readBody: 0, role: 0 };
  const raw = createRoleStore({ rolesDir, getInjectLimit: () => injectLimit });
  const store = {};
  for (const [key, value] of Object.entries(raw)) {
    store[key] = typeof value === 'function' ? (...args) => { calls.role += 1; return value(...args); } : value;
  }
  const routes = factory({
    roles: store,
    readRoleState: () => { calls.readState += 1; return { ...state }; },
    writeRoleState: (role, mode) => { calls.writeState += 1; state.role = role; state.mode = mode; },
    getInjectMaxChars: () => injectLimit,
    log: (message) => logs.push(message),
  });
  async function call(method, pathname, body) {
    let response;
    let readBodyCalls = 0;
    let sendJsonCalls = 0;
    const logStart = logs.length;
    const result = await routes.handle({ method }, new URL(pathname, 'http://console.local'), {
      readBody: async () => { readBodyCalls += 1; calls.readBody += 1; return body; },
      sendJson: (value, status = 200) => { sendJsonCalls += 1; response = { status, value }; },
    });
    return { result, response, readBodyCalls, sendJsonCalls, logs: logs.slice(logStart) };
  }
  return {
    routes, rolesDir, state, calls, call,
    matches: (method, pathname) => routes.matches(method, pathname),
    setLimit: (value) => { injectLimit = value; },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

// Summary mtimes differ between two fresh fixtures; everything else must match.
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'mtime' ? 'mtime' : normalize(item)]));
}

async function runScenario(h) {
  const steps = [];
  const out = {};
  const step = async (key, method, pathname, body) => {
    const record = await h.call(method, pathname, body);
    const entry = { ...record, state: { ...h.state } };
    steps.push({ key, entry });
    out[key] = entry;
    return entry;
  };
  await step('listEmpty', 'GET', '/api/roles');
  await step('contentMissing', 'GET', '/api/roles/content?name=missing');
  await step('contentInvalid', 'GET', '/api/roles/content?name=!!!');
  await step('create', 'POST', '/api/roles/create', { name: 'fixture 卡', content: CARD });
  await step('createExisting', 'POST', '/api/roles/create', { name: 'fixture卡', content: '# Existing' });
  await step('createInvalid', 'POST', '/api/roles/create', { name: 'CON', content: '# Device' });
  await step('list', 'GET', '/api/roles');
  await step('content', 'GET', '/api/roles/content?name=fixture卡');
  await step('updateAbsent', 'POST', '/api/roles/update', { name: 'ghost', content: '# Ghost' });
  await step('update', 'POST', '/api/roles/update', { name: 'fixture卡', content: UPDATED });
  await step('createOther', 'POST', '/api/roles/create', { name: 'other', content: '# Other' });
  h.state.role = 'fixture卡';
  h.state.mode = 'active';
  await step('renameCollision', 'POST', '/api/roles/rename', { from: 'fixture卡', to: 'other' });
  await step('renameSelf', 'POST', '/api/roles/rename', { from: 'other', to: 'other' });
  await step('renameCurrent', 'POST', '/api/roles/rename', { from: 'fixture卡', to: 'renamed' });
  h.setLimit(LIMIT);
  await step('listTruncated', 'GET', '/api/roles');
  await step('contentTruncated', 'GET', '/api/roles/content?name=renamed');
  h.setLimit(DEFAULT_LIMIT);
  await step('listRefreshed', 'GET', '/api/roles');
  await step('deleteCurrent', 'POST', '/api/roles/delete', { name: 'renamed' });
  await step('listAfterDelete', 'GET', '/api/roles');
  return { steps, out };
}

test('moved six role blocks match the frozen baseline on fresh fixtures', async () => {
  const baseline = createHarness(createBaselineRoleRoutes);
  const moved = createHarness(createRoleRoutes);
  try {
    const expected = await runScenario(baseline);
    const actual = await runScenario(moved);
    for (let i = 0; i < expected.steps.length; i++) {
      const left = expected.steps[i].entry;
      const right = actual.steps[i].entry;
      assert.equal(actual.steps[i].key, expected.steps[i].key);
      assert.equal(right.response?.status, left.response?.status, `status: ${expected.steps[i].key}`);
      assert.deepEqual(normalize(right.response?.value), normalize(left.response?.value), `body: ${expected.steps[i].key}`);
      assert.equal(right.readBodyCalls, left.readBodyCalls, `readBody calls: ${expected.steps[i].key}`);
      assert.equal(right.sendJsonCalls, left.sendJsonCalls, `sendJson calls: ${expected.steps[i].key}`);
      assert.deepEqual(right.logs, left.logs, `logs: ${expected.steps[i].key}`);
      assert.deepEqual(right.state, left.state, `roleState: ${expected.steps[i].key}`);
    }

    const { out } = actual;
    assert.deepEqual(out.listEmpty.response, {
      status: 200,
      value: { roles: [], summaries: [], current: null, limits: { nameMax: ROLE_NAME_MAX, contentMaxBytes: ROLE_CONTENT_MAX_BYTES, injectMaxChars: DEFAULT_LIMIT } },
    });
    assert.equal(out.create.response.value.role, 'fixture卡');
    assert.deepEqual(out.create.response.value.warnings, []);
    assert.deepEqual(out.createExisting.response.value, { ok: false, error: '人格「fixture卡」已存在' });
    assert.equal(out.createInvalid.response.status, 400);
    assert.equal(out.createInvalid.response.value.error, '「CON」是系统保留名称（Windows 设备名），请换一个');

    const list = out.list.response.value;
    assert.deepEqual(list.roles, ['fixture卡']);
    assert.equal(Array.isArray(list.summaries), true);
    assert.equal(typeof list.summaries[0].name, 'string');
    assert.equal(typeof list.summaries[0].bytes, 'number');
    assert.equal(typeof list.summaries[0].mtime, 'number');
    assert.equal(list.current, null);

    const loaded = out.content.response.value;
    const content = CARD + '\n';
    assert.equal(loaded.content, content);
    assert.equal(loaded.chars, content.length);
    assert.equal(loaded.bytes, Buffer.byteLength(content, 'utf8'));
    assert.deepEqual(loaded.stats, roleCharStats(content));
    assert.equal(Array.isArray(loaded.sections.v1), true);
    assert.equal(Array.isArray(loaded.sections.v2), true);
    assert.ok(loaded.sections.v2.some((section) => section.heading === '二代' && section.injected === true));
    assert.deepEqual(loaded.warnings, []);
    assert.deepEqual(loaded.limits, { injectMaxChars: DEFAULT_LIMIT });

    assert.equal(out.updateAbsent.response.status, 404);
    assert.equal(out.updateAbsent.response.value.error, '人格「ghost」不存在');
    assert.equal(out.update.response.value.chars, UPDATED.length);
    assert.equal(out.renameCollision.response.value.error, '人格「other」已存在');
    assert.equal(out.renameCollision.state.role, 'fixture卡', 'collision must not touch current role');
    assert.deepEqual(out.renameSelf.response.value, { ok: true, role: 'other', renamed: false });
    assert.deepEqual(out.renameCurrent.response.value, { ok: true, role: 'renamed', renamed: true, currentFollowed: true });
    assert.equal(out.renameCurrent.state.role, 'renamed', 'rename follows the current role');

    const truncated = out.listTruncated.response.value;
    const cut = truncated.summaries.find((summary) => summary.name === 'renamed');
    assert.equal(truncated.limits.injectMaxChars, LIMIT);
    assert.equal(cut.injectedV2, LIMIT);
    assert.equal(cut.truncated, true);
    assert.equal(cut.warnings, 1);
    assert.ok(out.contentTruncated.response.value.warnings.some((warning) => warning.includes(`只有前 ${LIMIT} 字符`)));
    assert.equal(out.contentTruncated.response.value.limits.injectMaxChars, LIMIT);

    const refreshed = out.listRefreshed.response.value;
    const full = refreshed.summaries.find((summary) => summary.name === 'renamed');
    assert.equal(refreshed.limits.injectMaxChars, DEFAULT_LIMIT, 'getter is re-read on every response');
    assert.equal(full.injectedV2, roleCharStats(STORED).v2);
    assert.equal(full.truncated, false);
    assert.deepEqual(out.deleteCurrent.response.value, { ok: true, deleted: 'renamed', clearedCurrent: true });
    assert.equal(out.deleteCurrent.state.role, null, 'deleting the current role clears it');
    assert.deepEqual(out.listAfterDelete.response.value.roles, ['other']);
  } finally {
    baseline.cleanup();
    moved.cleanup();
  }
});

test('matches is a synchronous exact-pair test and unknown handle does zero IO', async () => {
  const h = createHarness(createRoleRoutes, { seeded: '# Seeded' });
  try {
    for (const [method, pathname] of [
      ['GET', '/api/roles/limit'], ['POST', '/api/roles/limit'], ['POST', '/api/role'], ['GET', '/api/role-mode'],
      ['GET', '/api/Roles'], ['GET', '/api/roles/'], ['DELETE', '/api/roles'], ['POST', '/api/roles/content'],
      ['GET', '/api/roles/create'], ['GET', '/api/preset/sim-prompt'],
    ]) {
      assert.equal(h.matches(method, pathname), false, `${method} ${pathname}`);
    }
    for (const [method, pathname] of [
      ['GET', '/api/roles'], ['GET', '/api/roles/content'], ['POST', '/api/roles/create'],
      ['POST', '/api/roles/update'], ['POST', '/api/roles/rename'], ['POST', '/api/roles/delete'],
    ]) {
      assert.equal(h.matches(method, pathname), true, `${method} ${pathname}`);
    }
    const before = { ...h.calls };
    for (const [method, pathname] of [['GET', '/api/roles/limit'], ['GET', '/api/role'], ['POST', '/api/unknown'], ['GET', '/api/Roles']]) {
      const record = await h.call(method, pathname, {});
      assert.equal(record.result, false);
      assert.equal(record.response, undefined);
      assert.equal(record.readBodyCalls, 0);
      assert.equal(record.sendJsonCalls, 0);
      assert.deepEqual(record.logs, []);
    }
    assert.deepEqual(h.calls, before, 'unknown routes must not read state/body or call the role store');
  } finally {
    h.cleanup();
  }
});
