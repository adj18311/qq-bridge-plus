// Verify native ESM linkage as well as VM bindings: a source-evaluating harness
// alone could accidentally hide a missing or wrongly named production import.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import * as bindings from './bridge-core-bindings.mjs';

const bridgeUrl = new URL('../src/bridge.js', import.meta.url);
const source = fs.readFileSync(bridgeUrl, 'utf8');
const imports = [...source.matchAll(/^import\s*\{([^}]+)\}\s*from\s*['"](\.\/(?:core|console)\/[^'"]+)['"];?/gm)];

test('production bridge core and console imports resolve through the native ESM loader', async () => {
  assert.deepEqual(imports.map(([, , specifier]) => specifier).sort(), [
    './console/role-routes.mjs',
    './core/console-input.mjs', './core/dsh-connection-watch.mjs', './core/group-wait-policy.mjs',
    './core/group-wake-batch.mjs', './core/image-format.mjs', './core/json-store.mjs',
    './core/memory-text.mjs', './core/model-policy.mjs', './core/persona-text.mjs',
    './core/qq-text.mjs', './core/reply-timing.mjs', './core/role-store.mjs',
    './core/runtime-config.mjs', './core/runtime-records.mjs', './core/send-gaps.mjs',
    './core/session-store.mjs', './core/tool-log-format.mjs', './core/wake-policy.mjs',
    './core/wake-timers.mjs', './core/watchdog-policy.mjs',
  ]);
  const declarations = imports.map(([, names, specifier]) =>
    `import {${names}} from ${JSON.stringify(new URL(specifier, bridgeUrl).href)};`).join('\n');
  await import(`data:text/javascript;base64,${Buffer.from(declarations).toString('base64')}`);
});

test('VM core/console bindings are the same exported objects used by production imports', async () => {
  for (const [, names, specifier] of imports) {
    const module = await import(new URL(specifier, bridgeUrl).href);
    for (const name of names.split(',').map(name => name.trim()).filter(Boolean)) {
      assert.ok(Object.hasOwn(module, name), `${specifier} exports ${name}`);
      assert.equal(bindings[name], module[name], `${name} is not a copied or stubbed implementation`);
    }
  }
});

test('every full-bridge VM runner injects the shared core bindings, including standalone verifiers', () => {
  const scriptsDir = new URL('.', import.meta.url);
  const runners = fs.readdirSync(scriptsDir).filter(name => name.endsWith('.mjs')).map(name => ({
    name, text: fs.readFileSync(new URL(name, scriptsDir), 'utf8'),
  })).filter(({ text }) => text.includes('droppingImport') && /^\s*const context = vm\.createContext\(/m.test(text));
  for (const name of ['verify-busy-watchdog.mjs', 'verify-cross-session-send.mjs', 'verify-slang-selection.mjs']) {
    assert.ok(runners.some(runner => runner.name === name), `${name} must be covered by discovery`);
  }
  for (const { name, text } of runners) {
    assert.match(text, /import \* as coreBindings from ['"]\.\/bridge-core-bindings\.mjs['"]/, name);
    assert.match(text, /\.\.\.coreBindings\b/, `${name} injects the imported bindings`);
  }
});
