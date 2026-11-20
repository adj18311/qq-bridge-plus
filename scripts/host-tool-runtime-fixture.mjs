/**
 * 真实宿主工具运行时夹具：从 DSH 的 app.asar 里按需抽取 `@deepseek-ai/*` 包，
 * 再把**出厂版本**的 `ToolRuntime` / `Context` / `defineContentToolFixture` 交给测试。
 *
 * 目的：断言「execute 阶段改写 content 会被丢弃、post-execute 的 accept content 才是受支持落点」
 * 时，用的是与生产同一份源码，而不是自己写的模拟器。
 *
 * 约束：只读 asar、只写操作系统临时目录；找不到 asar 时由调用方跳过测试。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_ASAR = 'D:/DSH Desktop/resources/app.asar';
const BASE_PACKAGES = [
  'cordis',
  'dsh-tools',
  'dsh-scope',
  'dsh-util-values',
  'dsh-llm',
  'dsh-brand',
  'dsh-sandbox',
  'schemastery',
  'cosmokit',
  'dsh-typert-protocol',
  'dsh-util-crypto',
  'dsh-timeout',
  'dsh-llm',
];

function readAsarHeader(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const headerSize = head.readUInt32LE(4);
    const jsonSize = head.readUInt32LE(12);
    const buf = Buffer.alloc(jsonSize);
    fs.readSync(fd, buf, 0, jsonSize, 16);
    return { header: JSON.parse(buf.toString('utf8')), dataStart: 8 + headerSize, fd };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function findNode(header, target) {
  let cur = header;
  for (const part of target.split('/')) {
    if (!cur.files?.[part]) return null;
    cur = cur.files[part];
  }
  return cur;
}

function extractPackage({ header, dataStart, fd }, asarPath, cacheDir, pkgName) {
  const prefix = `dsh/node_modules/${pkgName}`;
  const entry = findNode(header, prefix);
  if (!entry || !entry.files) return false;
  let count = 0;
  const walk = (node, rel) => {
    for (const [name, value] of Object.entries(node.files ?? {})) {
      const nextRel = `${rel}/${name}`;
      if (value.files) { walk(value, nextRel); continue; }
      const dst = path.join(cacheDir, 'dsh', 'node_modules', pkgName, nextRel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      const size = value.size ?? 0;
      const buf = Buffer.alloc(size);
      if (size > 0) fs.readSync(fd, buf, 0, size, dataStart + Number(value.offset));
      fs.writeFileSync(dst, buf);
      count += 1;
    }
  };
  walk(entry, '');
  return count > 0;
}

/**
 * @returns {Promise<{Context:any, Service:any, ToolRuntime:any, defineContentToolFixture:any, cacheDir:string}>}
 */
export async function loadHostToolRuntime({ asarPath = process.env.DSH_ASAR || DEFAULT_ASAR } = {}) {
  if (!fs.existsSync(asarPath)) throw new Error(`找不到 DSH asar：${asarPath}`);
  const stat = fs.statSync(asarPath);
  const cacheDir = path.join(os.tmpdir(), `dsh-host-runtime-${stat.size}-${Math.trunc(stat.mtimeMs)}`);
  const marker = path.join(cacheDir, '.ready');
  const toolsIndex = path.join(cacheDir, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js');

  if (!fs.existsSync(marker)) {
    fs.mkdirSync(cacheDir, { recursive: true });
    const handle = readAsarHeader(asarPath);
    try {
      for (const pkg of BASE_PACKAGES) extractPackage(handle, asarPath, cacheDir, `@deepseek-ai/${pkg}`);
      // 迭代补齐 import 图里缺的包
      for (let attempt = 0; attempt < 24; attempt += 1) {
        const missing = await detectMissingPackage(toolsIndex);
        if (missing === null) break;
        const target = missing.startsWith('@deepseek-ai/') ? missing : null;
        if (target === null) throw new Error(`夹具缺少非 @deepseek-ai 依赖：${missing}`);
        if (!extractPackage(handle, asarPath, cacheDir, target)) throw new Error(`asar 中找不到 ${target}`);
      }
      const stillMissing = await detectMissingPackage(toolsIndex);
      if (stillMissing !== null) throw new Error(`夹具依赖仍缺：${stillMissing}`);
      fs.writeFileSync(marker, new Date().toISOString());
    } finally {
      fs.closeSync(handle.fd);
    }
  }

  const tools = await import(pathToFileURL(toolsIndex).href);
  const pipelineModule = await import(pathToFileURL(path.join(path.dirname(toolsIndex), 'pipeline.js')).href);
  const cordis = await import(pathToFileURL(path.join(cacheDir, 'dsh', 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js')).href);
  const llmIndex = path.join(cacheDir, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-llm', 'lib', 'index.js');
  const llm = fs.existsSync(llmIndex) ? await import(pathToFileURL(llmIndex).href) : null;
  return {
    Context: cordis.Context,
    Service: cordis.Service,
    ToolRuntime: tools.ToolRuntime,
    defineContentToolFixture: tools.defineContentToolFixture ?? buildContentToolFixture(tools.defineTool),
    ToolExecutionPipeline: pipelineModule.ToolExecutionPipeline,
    runTool: (ctx, runtime, input) => runToolThroughHost(ctx, runtime, input, {
      ToolExecutionPipeline: pipelineModule.ToolExecutionPipeline,
    }),
    llm,
    cacheDir,
  };
}

/**
 * 按宿主真实调用链跑一次工具：prepare → dispatch → finish。
 *
 * DSH 0.2.2-rc.1 把这三个阶段从 `ToolsService` 搬到了 `@deepseek-ai/dsh-tools/pipeline.js`
 * 的 `ToolExecutionPipeline`（旧名 `prepareScheduledExecution` / `dispatchScheduledExecution` /
 * `finalizeScheduledExecution` 已删除），所以测试不能再直接调运行时上的方法。
 * 这里两套都支持：老宿主走旧三连，新宿主用 pipeline 实例，调用方只见到一个 `runTool`。
 */
function runToolThroughHost(ctx, runtime, input, { ToolExecutionPipeline }) {
  if (typeof runtime?.prepareScheduledExecution === 'function') {
    return (async () => {
      const prepared = await runtime.prepareScheduledExecution(input);
      if (prepared.kind !== 'dispatch') return prepared.result;
      const dispatched = await runtime.dispatchScheduledExecution(prepared.exec);
      if (dispatched.kind !== 'post-result') return dispatched.result;
      return runtime.finalizeScheduledExecution(prepared.exec, dispatched.result);
    })();
  }
  if (typeof ToolExecutionPipeline !== 'function') {
    throw new Error('host-tool-runtime-fixture: 宿主既没有 prepareScheduledExecution，也没有 ToolExecutionPipeline');
  }
  const pipeline = new ToolExecutionPipeline(ctx);
  return (async () => {
    const prepared = await pipeline.prepare(input);
    if (prepared.kind !== 'dispatch') return prepared.result;
    const dispatched = await pipeline.dispatch(prepared.exec);
    if (dispatched.kind !== 'post-result') return dispatched.result;
    // 新宿主把旧 finalizeScheduledExecution 拆成两步：postExecute（tools/post-execute
    // 决策，负责装图片等内容改写）+ finish（最终内容物化与 tools/result 通知）。
    // 只调 finish 会跳过 post-execute，插件的附图逻辑就整体失效。
    const decided = typeof pipeline.postExecute === 'function'
      ? await pipeline.postExecute(prepared.exec, dispatched.result)
      : dispatched.result;
    return pipeline.finish(prepared.exec, decided);
  })();
}

/**
 * DSH 0.2.2-rc.1 的 `@deepseek-ai/dsh-tools` 只导出 `defineTool`，
 * 0.2.0 时代的 `defineContentToolFixture` 已经消失（实测 `export {}` 名单里没有它）。
 * 直接透传会让调用方拿到 undefined，测试就报
 * `TypeError: defineContentToolFixture is not a function`。
 *
 * 这里按旧语义在 `defineTool` 上重建：内容工具的输出是 content 数组，
 * schema 用 author-only 的 `json` 节点（编译后是 annotation-only schema，
 * 不做运行时强校验），render 保持恒等。
 */
function buildContentToolFixture(defineTool) {
  if (typeof defineTool !== 'function') {
    throw new Error('host-tool-runtime-fixture: dsh-tools 既没有 defineContentToolFixture 也没有 defineTool');
  }
  return function defineContentToolFixture(options = {}) {
    return defineTool({
      ...options,
      output: options.output ?? {
        schema: { type: 'json' },
        render: (_args, value) => value,
      },
    });
  };
}

async function detectMissingPackage(indexPath) {
  try {
    await import(`${pathToFileURL(indexPath).href}?probe=${Date.now()}`);
    return null;
  } catch (error) {
    const match = /Cannot find package '([^']+)'/.exec(String(error?.message ?? ''));
    return match ? match[1] : null;
  }
}