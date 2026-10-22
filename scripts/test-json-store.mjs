// node:test 套件：src/core/json-store.mjs 的原子读写与格式保留行为。
//
// 边界：所有文件操作都发生在 fs.mkdtempSync(os.tmpdir()) 创建的临时目录里，每个用例
// 用 finally 递归删除；不读取、不写入仓库里的 config.json / state/ 等任何生产文件。
// 重命名失败通过在本进程内临时替换 fs.renameSync 注入，结束后立即恢复。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  atomicWriteJson,
  atomicWriteJsonKeepStyle,
  atomicWriteText,
  localStamp,
  readConfigObject,
  readJsonSafe,
  renameWithRetry,
  uniqueBackupPath,
} from '../src/core/json-store.mjs';

function withTempDir(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'json-store-test-'));
  try {
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 递归列出临时目录里遗留的随机名临时文件（成功和失败路径都不应留下它们）。
function tmpLeftovers(dir) {
  return fs.readdirSync(dir, { recursive: true })
    .map(String)
    .filter((name) => name.endsWith('.tmp'));
}

// 在回调期间替换 fs.renameSync；无论回调是否抛错都会恢复原函数。
function patchRenameSync(impl, run) {
  const original = fs.renameSync;
  fs.renameSync = impl;
  try {
    return run();
  } finally {
    fs.renameSync = original;
  }
}

function renameError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

test('readJsonSafe parses JSON and strips a leading UTF-8 BOM', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'bom.json');
    fs.writeFileSync(file, '\uFEFF{"ok":true,"n":[1,2]}', 'utf8');
    assert.deepEqual(readJsonSafe(file, null), { ok: true, n: [1, 2] });
  });
});

test('readJsonSafe returns the fallback for missing or unparseable files', () => {
  withTempDir((dir) => {
    const fallback = { fallback: true };
    const missing = path.join(dir, 'missing.json');
    const broken = path.join(dir, 'broken.json');
    fs.writeFileSync(broken, '{not json', 'utf8');

    assert.equal(readJsonSafe(missing, fallback), fallback);
    assert.equal(readJsonSafe(broken, fallback), fallback);
  });
});

test('readJsonSafe required=true throws a fail-fast error for missing and broken files', () => {
  withTempDir((dir) => {
    const missing = path.join(dir, 'missing.json');
    const broken = path.join(dir, 'broken.json');
    fs.writeFileSync(broken, '{not json', 'utf8');

    for (const file of [missing, broken]) {
      assert.throws(
        () => readJsonSafe(file, null, true),
        (error) => error.message.startsWith(`配置文件读取/解析失败：${file}（`)
          && error.message.endsWith('）'),
        file,
      );
    }
  });
});

test('readConfigObject returns a plain writable object (BOM tolerated)', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, '\uFEFF{"ownerQQ":42}', 'utf8');
    const config = readConfigObject(file);
    assert.deepEqual(config, { ownerQQ: 42 });
    // 返回的就是解析结果本身：调用方可以安全地改字段再原子写回。
    config.ownerQQ = 43;
    assert.equal(config.ownerQQ, 43);
  });
});

test('readConfigObject rejects every non-object top level with the exact message', () => {
  withTempDir((dir) => {
    const cases = [
      ['null', null],
      ['array', []],
      ['string', 'text'],
      ['number', 42],
      ['boolean', true],
    ];
    for (const [label, value] of cases) {
      const file = path.join(dir, `${label}.json`);
      fs.writeFileSync(file, JSON.stringify(value), 'utf8');
      const kind = label === 'null' ? 'null' : label === 'array' ? '数组' : label;
      assert.throws(
        () => readConfigObject(file),
        (error) => error.message === `config.json 顶层不是对象（实际是 ${kind}），已拒绝改写以免覆盖整份配置：${file}`,
        label,
      );
    }
  });
});

test('readConfigObject refuses to continue when the file cannot be read', () => {
  withTempDir((dir) => {
    const missing = path.join(dir, 'config.json');
    assert.throws(
      () => readConfigObject(missing),
      (error) => error.message.startsWith(`配置文件读取/解析失败：${missing}（`),
    );
  });
});

test('atomicWriteJson writes canonical JSON, creates parent dirs, and cleans temp files', () => {
  withTempDir((dir) => {
    const target = path.join(dir, 'nested', 'state.json');
    const obj = { a: 1, b: { c: ['x', true, null] } };
    atomicWriteJson(target, obj);

    assert.equal(fs.readFileSync(target, 'utf8'), `${JSON.stringify(obj, null, 2)}\n`);
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), obj);
    assert.deepEqual(tmpLeftovers(dir), []);
  });
});

test('atomicWriteText writes the text verbatim, creates parent dirs, and cleans temp files', () => {
  withTempDir((dir) => {
    const target = path.join(dir, 'nested', 'token.txt');
    const content = 'line1\r\nline2\nno-trailing-newline';
    atomicWriteText(target, content);

    assert.equal(fs.readFileSync(target, 'utf8'), content);
    assert.deepEqual(tmpLeftovers(dir), []);
  });
});

test('atomicWriteJson removes its temp file when rename fails and leaves the target alone', () => {
  withTempDir((dir) => {
    const target = path.join(dir, 'state.json');
    const injected = renameError('ENOENT', 'injected rename failure');

    patchRenameSync(() => { throw injected; }, () => {
      assert.throws(() => atomicWriteJson(target, { a: 1 }), (error) => error === injected);
    });

    assert.equal(fs.existsSync(target), false);
    assert.deepEqual(tmpLeftovers(dir), []);
  });
});

test('atomicWriteText removes its temp file when rename fails', () => {
  withTempDir((dir) => {
    const target = path.join(dir, 'token.txt');
    const injected = renameError('ENOENT', 'injected rename failure');

    patchRenameSync(() => { throw injected; }, () => {
      assert.throws(() => atomicWriteText(target, 'secret'), (error) => error === injected);
    });

    assert.equal(fs.existsSync(target), false);
    assert.deepEqual(tmpLeftovers(dir), []);
  });
});

test('renameWithRetry retries EPERM/EBUSY/EACCES and succeeds', () => {
  withTempDir((dir) => {
    const from = path.join(dir, 'from.txt');
    const to = path.join(dir, 'to.txt');
    fs.writeFileSync(from, 'payload', 'utf8');
    const original = fs.renameSync;
    let calls = 0;

    patchRenameSync(function countedRename(fromArg, toArg) {
      calls += 1;
      if (calls < 3) throw renameError(calls === 1 ? 'EPERM' : 'EBUSY', 'transient rename failure');
      return original.call(fs, fromArg, toArg);
    }, () => {
      renameWithRetry(from, to);
    });

    assert.equal(calls, 3);
    assert.equal(fs.readFileSync(to, 'utf8'), 'payload');
    assert.equal(fs.existsSync(from), false);
  });
});

test('renameWithRetry rethrows non-retryable errors immediately', () => {
  withTempDir((dir) => {
    let calls = 0;
    const injected = renameError('ENOENT', 'not retryable');

    patchRenameSync(() => {
      calls += 1;
      throw injected;
    }, () => {
      assert.throws(
        () => renameWithRetry(path.join(dir, 'a'), path.join(dir, 'b')),
        (error) => error === injected,
      );
    });

    assert.equal(calls, 1);
  });
});

test('renameWithRetry throws the last error after exhausting attempts', () => {
  withTempDir((dir) => {
    const injected = renameError('EPERM', 'still busy');
    let calls = 0;

    patchRenameSync(() => {
      calls += 1;
      throw injected;
    }, () => {
      assert.throws(
        () => renameWithRetry(path.join(dir, 'a'), path.join(dir, 'b'), 2),
        (error) => error === injected,
      );
    });

    assert.equal(calls, 2);
  });
});

test('localStamp formats local date parts with zero padding', () => {
  assert.equal(localStamp(new Date(2026, 0, 2, 3, 4, 5)), '20260102T030405');
  assert.equal(localStamp(new Date(2026, 11, 31, 23, 59, 59)), '20261231T235959');
  assert.match(localStamp(), /^\d{8}T\d{6}$/);
});

test('uniqueBackupPath returns a free name and never overwrites an existing backup', () => {
  withTempDir((dir) => {
    const base = path.join(dir, 'config.json.bak-switch-20260102T030405');
    assert.equal(uniqueBackupPath(base), base);

    fs.writeFileSync(base, 'first', 'utf8');
    assert.equal(uniqueBackupPath(base), `${base}-2`);

    fs.writeFileSync(`${base}-2`, 'second', 'utf8');
    assert.equal(uniqueBackupPath(base), `${base}-3`);
  });
});

test('uniqueBackupPath fails loudly when every candidate name is taken', () => {
  withTempDir((dir) => {
    const base = path.join(dir, 'config.json.bak');
    fs.writeFileSync(base, '', 'utf8');
    for (let i = 2; i < 100; i += 1) fs.writeFileSync(`${base}-${i}`, '', 'utf8');

    assert.throws(
      () => uniqueBackupPath(base),
      (error) => error.message === `备份名冲突太多：${base}`,
    );
  });
});

test('atomicWriteJsonKeepStyle reuses the canonical writer for the repository style', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, `${JSON.stringify({ a: 1 }, null, 2)}\n`, 'utf8');
    const style = atomicWriteJsonKeepStyle(file, { a: 2, b: 'x' });

    assert.deepEqual(style, { bom: false, indent: '  ', eol: '\n', trailingNewline: true });
    assert.equal(fs.readFileSync(file, 'utf8'), `${JSON.stringify({ a: 2, b: 'x' }, null, 2)}\n`);
    assert.deepEqual(tmpLeftovers(dir), []);
  });
});

test('atomicWriteJsonKeepStyle preserves a BOM', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, '\uFEFF{\n  "a": 1\n}\n', 'utf8');
    const style = atomicWriteJsonKeepStyle(file, { a: 2 });

    assert.deepEqual(style, { bom: true, indent: '  ', eol: '\n', trailingNewline: true });
    const raw = fs.readFileSync(file, 'utf8');
    assert.equal(raw.charCodeAt(0), 0xFEFF);
    assert.equal(raw.slice(1), `${JSON.stringify({ a: 2 }, null, 2)}\n`);
  });
});

test('atomicWriteJsonKeepStyle preserves CRLF line endings', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, '{\r\n  "a": 1\r\n}\r\n', 'utf8');
    const style = atomicWriteJsonKeepStyle(file, { a: 2, b: 'x' });

    assert.deepEqual(style, { bom: false, indent: '  ', eol: '\r\n', trailingNewline: true });
    const expected = `${JSON.stringify({ a: 2, b: 'x' }, null, 2).split('\n').join('\r\n')}\r\n`;
    assert.equal(fs.readFileSync(file, 'utf8'), expected);
  });
});

test('atomicWriteJsonKeepStyle preserves tab indentation', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, '{\n\t"a": 1\n}\n', 'utf8');
    const style = atomicWriteJsonKeepStyle(file, { a: 2 });

    assert.deepEqual(style, { bom: false, indent: '\t', eol: '\n', trailingNewline: true });
    assert.equal(fs.readFileSync(file, 'utf8'), `${JSON.stringify({ a: 2 }, null, '\t')}\n`);
  });
});

test('atomicWriteJsonKeepStyle keeps a compact single-line file compact', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, '{"a":1}', 'utf8');
    const style = atomicWriteJsonKeepStyle(file, { a: 2, b: 'x' });

    assert.deepEqual(style, { bom: false, indent: '  ', eol: '\n', trailingNewline: false });
    assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify({ a: 2, b: 'x' }));
    assert.equal(fs.readFileSync(file, 'utf8').includes('\n'), false);
  });
});

test('atomicWriteJsonKeepStyle preserves the absence of a trailing newline', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, '{\n  "a": 1\n}', 'utf8');
    const style = atomicWriteJsonKeepStyle(file, { a: 2 });

    assert.deepEqual(style, { bom: false, indent: '  ', eol: '\n', trailingNewline: false });
    assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify({ a: 2 }, null, 2));
  });
});

test('atomicWriteJsonKeepStyle creates a missing file with the canonical style', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'new', 'config.json');
    const style = atomicWriteJsonKeepStyle(file, { fresh: true });

    assert.deepEqual(style, { bom: false, indent: '  ', eol: '\n', trailingNewline: true });
    assert.equal(fs.readFileSync(file, 'utf8'), `${JSON.stringify({ fresh: true }, null, 2)}\n`);
    assert.deepEqual(tmpLeftovers(dir), []);
  });
});

test('atomicWriteJsonKeepStyle cleans its temp file and keeps the old file when rename fails', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'config.json');
    const before = '\uFEFF{\n  "a": 1\n}\n';
    fs.writeFileSync(file, before, 'utf8');
    const injected = renameError('ENOENT', 'injected rename failure');

    patchRenameSync(() => { throw injected; }, () => {
      assert.throws(() => atomicWriteJsonKeepStyle(file, { a: 2 }), (error) => error === injected);
    });

    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.deepEqual(tmpLeftovers(dir), []);
  });
});
