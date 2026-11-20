import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listQzoneTests, runQzoneTests } from './qzone-test-runner.mjs';

test('独立入口只选择指定目录内的 QQ 空间测试文件并稳定排序', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-suite-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const name of ['test-qzone-z.mjs', 'test-qzone-a.mjs', 'test-other.mjs', 'test-qzone-a.js']) await writeFile(join(dir, name), '');
  await mkdir(join(dir, 'test-qzone-dir.mjs'));
  assert.deepEqual(listQzoneTests(dir), [join(dir, 'test-qzone-a.mjs'), join(dir, 'test-qzone-z.mjs')]);
});

test('独立入口无测试或子进程启动失败时返回失败，非零退出码原样传递', () => {
  let invoked = false;
  assert.equal(runQzoneTests([], { spawn: () => { invoked = true; } }), 1);
  assert.equal(invoked, false);
  assert.equal(runQzoneTests(['a'], { spawn: () => ({ error: new Error('failed') }) }), 1);
  assert.equal(runQzoneTests(['a'], { spawn: () => ({ status: 7 }) }), 7);
  assert.equal(runQzoneTests(['a'], { spawn: () => ({ status: 0 }) }), 0);
});

test('独立入口不经 shell 展开，向 Node 传入明确测试文件', () => {
  let args;
  const code = runQzoneTests(['a b', 'c'], { spawn: (...values) => { args = values; return { status: 0 }; } });
  assert.equal(code, 0);
  assert.equal(args[0], process.execPath);
  assert.deepEqual(args[1], ['--test', 'a b', 'c']);
  assert.equal(args[2].shell, false);
});
