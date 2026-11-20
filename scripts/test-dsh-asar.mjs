import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { discoverDshAsar, DSH_PROCESS_QUERIES } from '../scripts/dsh-asar.mjs';

// 该文件只测「定位 DSH 安装目录」这一步，不读 asar、不启进程、不联网。
// 每个用例独立注入 runCommand/exists，因此不依赖本机 WMI 是否健康。

function fakeRun(map) {
  const calls = [];
  const run = (query) => {
    calls.push(query);
    const hit = map[query];
    if (hit === undefined) return '';
    if (hit instanceof Error) throw hit;
    return hit;
  };
  return { run, calls };
}

const WIN = 'D:\\DSH Desktop\\DeepSeek Harness.exe';

test('CIM 正常：直接取到带上 resources/app.asar 的路径', () => {
  const { run, calls } = fakeRun({ [DSH_PROCESS_QUERIES.cim]: JSON.stringify(WIN) });
  const seen = [];
  const result = discoverDshAsar({
    platform: 'win32',
    env: {},
    runCommand: run,
    exists: (p) => { seen.push(p); return true; },
  });
  assert.equal(result, path.join('D:\\DSH Desktop', 'resources', 'app.asar'));
  assert.equal(calls.length, 1, 'CIM 成功就不该再问 Get-Process');
  assert.deepEqual(seen, [result]);
});

test('CIM 返回空数组：回退到 Get-Process 并成功', () => {
  const { run, calls } = fakeRun({
    [DSH_PROCESS_QUERIES.cim]: '[]',
    [DSH_PROCESS_QUERIES.getProcess]: JSON.stringify(WIN),
  });
  const result = discoverDshAsar({ platform: 'win32', env: {}, runCommand: run, exists: () => true });
  assert.equal(result, path.join('D:\\DSH Desktop', 'resources', 'app.asar'));
  assert.deepEqual(calls, [DSH_PROCESS_QUERIES.cim, DSH_PROCESS_QUERIES.getProcess]);
});

test('CIM 抛错（超时 / 被禁用）：回退到 Get-Process 并成功', () => {
  const { run, calls } = fakeRun({
    [DSH_PROCESS_QUERIES.cim]: new Error('spawnSync powershell.exe ETIMEDOUT'),
    [DSH_PROCESS_QUERIES.getProcess]: JSON.stringify(WIN),
  });
  const result = discoverDshAsar({ platform: 'win32', env: {}, runCommand: run, exists: () => true });
  assert.equal(result, path.join('D:\\DSH Desktop', 'resources', 'app.asar'));
  assert.equal(calls.length, 2);
});

test('CIM 输出不是合法 JSON：回退到 Get-Process', () => {
  const { run } = fakeRun({
    [DSH_PROCESS_QUERIES.cim]: '<html>Access denied</html>',
    [DSH_PROCESS_QUERIES.getProcess]: JSON.stringify(WIN),
  });
  assert.equal(
    discoverDshAsar({ platform: 'win32', env: {}, runCommand: run, exists: () => true }),
    path.join('D:\\DSH Desktop', 'resources', 'app.asar'),
  );
});

test('CIM 给的路径旁没有 resources/app.asar：回退到 Get-Process', () => {
  const other = 'D:\\SomewhereElse\\DeepSeek Harness.exe';
  const { run, calls } = fakeRun({
    [DSH_PROCESS_QUERIES.cim]: JSON.stringify(other),
    [DSH_PROCESS_QUERIES.getProcess]: JSON.stringify(WIN),
  });
  const result = discoverDshAsar({
    platform: 'win32',
    env: {},
    runCommand: run,
    exists: (p) => p === path.join('D:\\DSH Desktop', 'resources', 'app.asar'),
  });
  assert.equal(result, path.join('D:\\DSH Desktop', 'resources', 'app.asar'));
  assert.equal(calls.length, 2);
});

test('两段都返回空：null（调用方据此跳过）', () => {
  const { run, calls } = fakeRun({ [DSH_PROCESS_QUERIES.cim]: '[]', [DSH_PROCESS_QUERIES.getProcess]: '' });
  assert.equal(discoverDshAsar({ platform: 'win32', env: {}, runCommand: run, exists: () => true }), null);
  assert.equal(calls.length, 2);
});

test('两段都抛错：null，且异常不外泄', () => {
  const { run } = fakeRun({
    [DSH_PROCESS_QUERIES.cim]: new Error('ETIMEDOUT'),
    [DSH_PROCESS_QUERIES.getProcess]: new Error('EPERM'),
  });
  assert.equal(discoverDshAsar({ platform: 'win32', env: {}, runCommand: run, exists: () => true }), null);
});

test('Get-Process 返回多个进程：取第一个真实存在的', () => {
  const list = ['E:\\old\\DeepSeek Harness.exe', WIN];
  const { run } = fakeRun({ [DSH_PROCESS_QUERIES.cim]: '', [DSH_PROCESS_QUERIES.getProcess]: JSON.stringify(list) });
  const result = discoverDshAsar({
    platform: 'win32',
    env: {},
    runCommand: run,
    exists: (p) => p === path.join('D:\\DSH Desktop', 'resources', 'app.asar'),
  });
  assert.equal(result, path.join('D:\\DSH Desktop', 'resources', 'app.asar'));
});

test('非 win32 平台：null，且一次命令都不跑', () => {
  const { run, calls } = fakeRun({ [DSH_PROCESS_QUERIES.cim]: JSON.stringify(WIN) });
  assert.equal(discoverDshAsar({ platform: 'linux', env: {}, runCommand: run, exists: () => true }), null);
  assert.equal(calls.length, 0);
});

test('DSH_INSTALL_ASAR 覆盖：原样返回，不跑命令', () => {
  const { run, calls } = fakeRun({});
  assert.equal(
    discoverDshAsar({ platform: 'win32', env: { DSH_INSTALL_ASAR: 'X:\\custom\\app.asar' }, runCommand: run }),
    'X:\\custom\\app.asar',
  );
  assert.equal(calls.length, 0);
});

test('两条查询互不相同（防两段退化成同一条命令）', () => {
  assert.notEqual(DSH_PROCESS_QUERIES.cim, DSH_PROCESS_QUERIES.getProcess);
  assert.match(DSH_PROCESS_QUERIES.cim, /Get-CimInstance Win32_Process/);
  assert.match(DSH_PROCESS_QUERIES.getProcess, /Get-Process/);
});

test('返回路径用当前平台的 path 拼接（Windows 下必须是反斜杠 + resources/app.asar）', () => {
  const { run } = fakeRun({ [DSH_PROCESS_QUERIES.cim]: JSON.stringify(WIN) });
  const result = discoverDshAsar({ platform: 'win32', env: {}, runCommand: run, exists: () => true });
  assert.ok(result.endsWith(`${path.sep}resources${path.sep}app.asar`), result);
  assert.ok(!result.includes('/'), `不允许出现正斜杠: ${result}`);
});