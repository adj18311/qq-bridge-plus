// 静态验证 qq-mode-console 插件在新版 DSH API 下是否仍可注册设置命名空间。
// 通过 mock settings 服务模拟 ctx，不接触真实 DSH 进程。
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const pluginPath = path.resolve(process.cwd(), 'plugins/qq-mode-console/lib/index.js');
const mod = await import(pathToFileURL(pluginPath).href);

console.log('exports:', Object.keys(mod).join(', '));
console.log('name =', mod.name);
console.log('inject =', JSON.stringify(mod.inject));

const calls = [];
const mockSettings = {
  register(ns, schema, options) {
    calls.push({ ns, options });
    // 模拟真实 register：用 schema 解析一次 base，验证 schema 本身合法
    const resolved = schema({ ...(options?.base ?? {}) });
    return { get: () => resolved, update: () => {}, replace: () => {} };
  }
};

const effects = [];
const ctx = {
  settings: mockSettings,
  effect: (fn, label) => { effects.push(label ?? 'anon'); return () => {}; },
  _inject: undefined
};

mod.apply(ctx, {});

console.log('\nregister 调用:', JSON.stringify(calls, null, 2));

// 校验 schema 对新版 settings API 的契约：register(ns, schema, { base, applies })
const c = calls[0];
const ok = c
  && c.ns === 'qq-mode'
  && typeof c.options?.base === 'object'
  && c.options.base.mode === 'reserved2';
console.log('\n命名空间注册形态与新 API 一致:', ok ? 'YES' : 'NO');

// schema 解析结果
const schema = mod.QqModeSchema;
console.log('schema default =', JSON.stringify(schema({})));
console.log('schema with ownerQQ =', JSON.stringify(schema({ mode: 'reserved2', ownerQQ: '123456789' })));
try {
  schema({ mode: 'bogus' });
  console.log('❌ 非法 mode 未被拒绝');
} catch {
  console.log('✅ 非法 mode 被 schema 拒绝');
}
