#!/usr/bin/env node
/**
 * check-reasoning-effort.mjs —— 钉住「minimax-cn 这个模型到底接受哪些 reasoningEffort」
 *
 * 背景（2026-10-09 实测 + 读 DSH 应用包源码得到，别推翻）
 * ---------------------------------------------------------------------------
 * DSH 的报错链：
 *   bridge.js ensureChatModel() 总是把 cfg.dsh.reasoningEffort 塞进
 *   session.selectModel({ provider, model, reasoningEffort })
 *     → dsh-api-session-controller: llm.resolveCallConfig()
 *       → dsh-llm: 若这个模型的 reasoning 元数据缺失（undefined），
 *         只要请求里带了 reasoningEffort 就抛
 *         `provider "X" model "Y" does not support reasoning effort "Z"`（UNSUPPORTED_REASONING_EFFORT）
 *         → 被包成 session/model-unavailable，会话退回 DSH 默认模型。
 *
 * 这个模型的 reasoning 元数据从哪来（dsh-llm-pi-ai 的 resolveRouteModels/resolveModelReasoning）：
 *   `reasoningEfforts` 只在**配置里显式声明**时才有；否则用「同 id 的 pi-ai 内置目录条目」的能力，
 *   两者都没有 ⇒ `reasoning: false` ⇒ pi-ai 只报一个档位 `off`。
 *   本机 pi-ai 目录（0.87.1）里 minimax-cn 只有 MiniMax-M2.7 / M2.7-highspeed / M3，
 *   所以 MiniMax-M3.1-Flash-Preview 是「目录里没有的手写条目」⇒ 只支持 off。
 *
 * 本脚本只读：从 DSH 应用包里抽 pi-ai 的模型目录（首次运行会解出几个小文件到
 * state/effort-probe/），再用 pi-ai 自己的 getSupportedThinkingLevels() 算支持集合。
 * 不联网、不改任何配置、不碰桥接。
 *
 * 用法：
 *   node scripts/check-reasoning-effort.mjs [--json] [--keep]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = path.join(ROOT, 'state');
const EXTRACT_DIR = path.join(STATE_DIR, 'effort-probe');
const ASAR = process.env.DSH_ASAR || 'D:\\DSH Desktop\\resources\\app.asar';
const PI_AI_PREFIX = '/dsh/node_modules/@earendil-works/pi-ai/';

/**
 * 要判定的档位（与 scripts/switch-model.mjs 的 PROFILES 保持一致）。
 *
 * 只列 **pi-ai 路由**：DeepSeek 档位走的是另一个 adapter（dsh-llm-deepseek），
 * 支持集合写死在那边的代码里（off / low / high / max），不归本脚本判定。
 */
const TARGETS = [
  { id: 'minimax', provider: 'minimax-cn', model: 'MiniMax-M3.1-Flash-Preview' },
];

const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

function readAsarHeader(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const jsonLen = head.readUInt32LE(12);
    const pickleSize = head.readUInt32LE(4);
    const jsonBuf = Buffer.alloc(jsonLen);
    fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
    return { header: JSON.parse(jsonBuf.toString('utf8')), base: 8 + pickleSize };
  } finally {
    fs.closeSync(fd);
  }
}

function walk(node, prefix = '', out = []) {
  for (const [name, value] of Object.entries(node.files ?? {})) {
    const p = `${prefix}/${name}`;
    if (value.files) walk(value, p, out);
    else if (value.offset !== undefined && value.size !== undefined) out.push([p, Number(value.offset), Number(value.size)]);
  }
  return out;
}

/** 抽 pi-ai 的 providers/** 到 state/effort-probe（缓存：已解过就跳过）。 */
function extractPiAi({ keep = false } = {}) {
  const marker = path.join(EXTRACT_DIR, '.complete');
  if (fs.existsSync(marker)) return { extracted: 0, cached: true };
  if (!fs.existsSync(ASAR)) throw new Error(`找不到 DSH 应用包：${ASAR}（可用 DSH_ASAR 环境变量覆盖）`);
  const { header, base } = readAsarHeader(ASAR);
  const entries = walk(header);
  fs.mkdirSync(EXTRACT_DIR, { recursive: true });
  const fd = fs.openSync(ASAR, 'r');
  let n = 0;
  try {
    for (const [p, off, size] of entries) {
      if (!p.startsWith(PI_AI_PREFIX)) continue;
      const rel = p.slice(PI_AI_PREFIX.length);
      const dest = path.join(EXTRACT_DIR, rel.split('/').join(path.sep));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, base + off);
      fs.writeFileSync(dest, buf);
      n += 1;
    }
  } finally {
    fs.closeSync(fd);
  }
  fs.writeFileSync(marker, `${new Date().toISOString()} files=${n}\n`, 'utf8');
  if (!keep) { /* 缓存保留：体积很小，重跑不用再解包 */ }
  return { extracted: n, cached: false };
}

/** 复刻 dsh-llm-pi-ai resolveModelReasoning：没有 reasoningEfforts 就用目录条目的能力。 */
function declaredReasoning(entry, base) {
  if (entry.reasoningEfforts !== undefined) return entry.reasoningEfforts;
  const reasoning = base?.reasoning ?? false;
  return reasoning ? true : undefined;
}

async function main() {
  const json = process.argv.includes('--json');
  const human = (msg = '') => (json ? process.stderr : process.stdout).write(`${msg}\n`);
  const result = { ok: true, asar: ASAR, extract: null, targets: [], warnings: [] };

  const ex = extractPiAi();
  result.extract = ex;
  human(`pi-ai 抽取：${ex.cached ? '命中缓存' : `解出 ${ex.extracted} 个文件`} → ${path.relative(ROOT, EXTRACT_DIR)}`);

  const piRoot = pathToFileURL(EXTRACT_DIR + path.sep).href;
  const { getSupportedThinkingLevels } = await import(`${piRoot}dist/models.js`);
  const { MINIMAX_CN_MODELS } = await import(`${piRoot}dist/providers/minimax-cn.models.js`);

  const minimaxCatalog = new Set(Object.keys(MINIMAX_CN_MODELS));
  human(`pi-ai 0.87.1 内置 minimax-cn 目录：${[...minimaxCatalog].join(', ')}`);

  for (const t of TARGETS) {
    const base = t.provider === 'minimax-cn' ? MINIMAX_CN_MODELS[t.model] : undefined;
    const entry = { id: t.model, name: t.model, provider: t.provider };
    const reasoning = declaredReasoning(entry, base);
    const descriptor = {
      id: t.model,
      provider: t.provider,
      api: base?.api ?? 'anthropic-messages',
      reasoning,
      ...(base?.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: base.thinkingLevelMap }),
    };
    const supported = base
      ? getSupportedThinkingLevels(base)
      : (reasoning ? getSupportedThinkingLevels(descriptor) : ['off']);
    const row = {
      ...t,
      inInstalledCatalog: Boolean(base),
      catalogReasoning: base?.reasoning ?? null,
      effectiveReasoning: reasoning ?? false,
      supported,
      rejected: LEVELS.filter((l) => !supported.includes(l)),
    };
    result.targets.push(row);
    human('');
    human(`${t.provider} / ${t.model}`);
    human(`  在内置目录里：${row.inInstalledCatalog ? '是' : '否（配置手写条目）'}；reasoning=${row.effectiveReasoning}`);
    human(`  支持的 reasoningEffort：${supported.join(', ')}`);
    human(`  会被拒的值：${row.rejected.join(', ') || '(无)'}`);
  }

  // 钉住结论：MiniMax-M3.1 只接受 off；DeepSeek 档位不在这里判定（另一套 adapter，接受 low/high/max）。
  const mm = result.targets.find((t) => t.id === 'minimax');
  if (!mm || mm.supported.join(',') !== 'off') {
    result.ok = false;
    result.warnings.push(`MiniMax 支持集合变了：现在报 ${mm ? mm.supported.join(',') : '(缺)'} —— DSH 升级/配置变化后请重新调查。`);
  }
  if (mm && mm.inInstalledCatalog) {
    result.warnings.push('这个模型现在进了 pi-ai 内置目录，支持集合应按目录条目重算。');
  }

  if (json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else {
    human('');
    for (const w of result.warnings) human(`⚠️ ${w}`);
    human(`结论：minimax-cn / MiniMax-M3.1-Flash-Preview 只接受 reasoningEffort="off"（= 不发思考参数，用模型自己的默认）。`);
  }
  if (!result.ok) process.exitCode = 2;
  return result;
}

await main();
