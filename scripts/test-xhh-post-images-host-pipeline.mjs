/**
 * 真实宿主 ToolRuntime 全链测试：execute → normalizeDispatchResult → post-execute → finalize。
 *
 * 为什么需要它：小黑盒帖子图片功能第一版把图片追加在 `tools/execute` 返回的结果里，
 * 而 DSH 的 `normalizeDispatchResult` 会用**冻结的 value 重新 render** content，追加内容被静默丢弃。
 * 只有 `tools/post-execute` 的 `{kind:'accept', content}` 会被 markCanonical 保留。
 *
 * 本测试直接使用出厂 `ToolRuntime`（从 DSH app.asar 抽取，见 host-tool-runtime-fixture.mjs），
 * 因此旧实现必须是 RED、新实现才是 GREEN —— 不是自己写模拟器得出的结论。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { loadHostToolRuntime } from './host-tool-runtime-fixture.mjs';
import { applyWithDeps } from '../plugins/xhh-quota-guard/index.mjs';

// 宿主运行时只解析一次：夹具会按 asar 的 size+mtime 缓存解包结果。
const HOST = await loadHostToolRuntime();

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const IMAGE_HOST = 'imgheybox.max-c.com';
const detailText = (withImage) => JSON.stringify({
  title: '离线夹具',
  images: withImage ? [`https://${IMAGE_HOST}/p.png`] : [],
});

const FULL = (name) => `mcp__xiaoheihe__${name}`;

function makeClient() {
  return {
    authorize: async () => ({ ok: true, decision: 'allow', exemption: 'quota', ticket: { kind: 'read', ticketId: 'ticket-1' } }),
    commit: async (request) => ({ ok: true, started: true, ticket: { ...request.ticket, state: 'started' } }),
    abort: async () => ({ ok: true, aborted: true, rolledBack: true }),
    complete: async () => ({ ok: true, completed: true }),
  };
}

async function boot({ withImage = true, toolName = FULL('get_post_detail') } = {}) {
  const { Context, Service, ToolRuntime, defineContentToolFixture, llm } = HOST;
  class FakePrompt extends Service {
    constructor(ctx) { super(ctx, 'systemPrompt', true); }
    tools() { return { dispose() {} }; }
    section() { return { dispose() {} }; }
    getSectionOrder() { return 0; }
  }
  const ctx = new Context();
  ctx.plugin(FakePrompt);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const savedImages = [];
  // 与宿主一致的视觉准入依赖：llm.resolveModelInfo 必须声明 inputModalities 含 image。
  ctx.provide('llm', {
    async resolveModelInfo(provider, model) {
      return { provider, model, inputModalities: provider === 'fixture-provider' ? ['text', 'image'] : ['text'] };
    },
  });
  ctx.provide('attachments', {
    async saveImages(inputs) {
      return inputs.map((input, index) => {
        savedImages.push({ mediaType: input.mediaType, bytes: input.data.byteLength });
        return { attachmentId: `att-${index + 1}`, mediaType: input.mediaType, bytes: input.data.byteLength };
      });
    },
  });
  const runtime = new ToolRuntime(ctx, { mode: 'native' });
  runtime.register(defineContentToolFixture({
    name: toolName,
    description: '离线帖子详情',
    parameters: {},
    async execute() { return [{ type: 'text', text: detailText(withImage) }]; },
  }));
  let fetches = 0;
  applyWithDeps(ctx, { enabled: true, timeoutMs: 500, ...makeClient() }, {
    fetchBuffer: async () => { fetches += 1; return { buffer: PNG, contentType: 'image/png' }; },
  });
  return { ctx, runtime, fetches: () => fetches, toolName, savedImages, llm };
}

async function runPipeline(ctx, name) {
  const ac = new AbortController();
  // 0.2.2-rc.1 的宿主把 prepare/dispatch/finalize 三连搬进了 ToolExecutionPipeline，
  // 运行时上已经没有 prepareScheduledExecution；夹具的 runTool 两套宿主都适配。
  return HOST.runTool(ctx, ctx.tools, {
    name,
    arguments: {},
    callId: `call-${Math.random().toString(16).slice(2)}`,
    signal: ac.signal,
    agent: {
      id: 'agent-fixture',
      options: { provider: 'fixture-provider', model: 'fixture-vision-model' },
      session: {
        id: 'session-fixture',
        requestHeader: () => ({ config: { provider: 'fixture-provider', model: 'fixture-vision-model' } }),
      },
    },
  });
}

const imageCount = (result) => (result.content ?? []).filter((item) => item?.type === 'image').length;

test('真实宿主全链：图片由 post-execute 落点进入最终 content，形状符合宿主模型内容词汇', async (t) => {
  try {
    const { ctx, runtime, fetches, toolName, savedImages, llm } = await boot();
    const final = await runPipeline(ctx, toolName);
    assert.equal(final.isError, false);
    assert.equal(imageCount(final), 1, `最终 content 必须含 1 个 image 块，实际 ${imageCount(final)}`);
    assert.equal(fetches(), 1, '应只抓一次图');
    assert.equal(savedImages.length, 1, '应把图片写入宿主附件存储');
    assert.equal(savedImages[0].mediaType, 'image/png');

    const block = final.content.find((item) => item?.type === 'image');
    assert.ok(block.attachment?.attachmentId, 'image 块必须带 attachment 引用（宿主 ImageBlock 形状）');
    assert.equal(block.mimeType, undefined, '不得出现 mimeType/data 形状');
    assert.equal(block.data, undefined, '不得出现 base64 data 形状');

    // 真实 dsh-llm 的文本模型投影：形状不对会在这里抛 TypeError（attachment 解引用）
    assert.ok(llm?.projectImagesForTextModel, '夹具应能载入 dsh-llm');
    const projected = llm.projectImagesForTextModel([{ role: 'user', content: final.content }]);
    assert.ok(Array.isArray(projected), '投影结果必须是数组');
    assert.equal(projected[0].content.filter((item) => item?.type === 'image').length, 0, '文本模型投影后不应再有 image 块');
  } catch (error) {
    if (/找不到 DSH asar/u.test(String(error.message))) { t.skip('本机没有 DSH asar，跳过真实宿主夹具'); return; }
    throw error;
  }
});

test('宿主没有 attachments 服务：不产出非法 image 块，改为文字说明', async (t) => {
  try {
    const { Context, Service, ToolRuntime, defineContentToolFixture } = await loadHostToolRuntime();
    class FakePrompt extends Service {
      constructor(ctx) { super(ctx, 'systemPrompt', true); }
      tools() { return { dispose() {} }; }
      section() { return { dispose() {} }; }
      getSectionOrder() { return 0; }
    }
    const ctx = new Context();
    ctx.plugin(FakePrompt);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const runtime = new ToolRuntime(ctx, { mode: 'native' });
    runtime.register(defineContentToolFixture({
      name: FULL('get_post_detail'),
      description: '离线帖子详情',
      parameters: {},
      async execute() { return [{ type: 'text', text: detailText(true) }]; },
    }));
    applyWithDeps(ctx, { enabled: true, timeoutMs: 500, ...makeClient() }, {
      fetchBuffer: async () => ({ buffer: PNG, contentType: 'image/png' }),
    });
    const final = await runPipeline(ctx, FULL('get_post_detail'));
    assert.equal(imageCount(final), 0, '没有附件存储时不得产出 image 块（否则 LLM 层会崩）');
    const texts = final.content.filter((item) => typeof item?.text === 'string').map((item) => item.text).join('\n');
    assert.match(texts, /图片未附上|附件/u, '应留下文字说明，而不是静默丢图');
  } catch (error) {
    if (/找不到 DSH asar/u.test(String(error.message))) { t.skip('本机没有 DSH asar，跳过真实宿主夹具'); return; }
    throw error;
  }
});

test('RED 证据：在 tools/execute 阶段追加的图片会被宿主归一化丢弃', async (t) => {
  try {
    const { ctx, runtime, toolName } = await boot({ withImage: false, toolName: FULL('get_home_content') });
    ctx.on('tools/execute', async (exec, next) => {
      const result = await next();
      if (exec.name !== toolName) return result;
      return { ...result, content: [...result.content, { type: 'image', mimeType: 'image/png', data: PNG.toString('base64') }] };
    });
    const final = await runPipeline(ctx, toolName);
    assert.equal(
      imageCount(final),
      0,
      'execute 阶段追加的图片块必须被丢弃（若这里变成 1，说明宿主语义变了，post-execute 迁移的前提需要重新评估）',
    );
  } catch (error) {
    if (/找不到 DSH asar/u.test(String(error.message))) { t.skip('本机没有 DSH asar，跳过真实宿主夹具'); return; }
    throw error;
  }
});

test('下游 block：最终结果是错误反馈，且不抓图、不追加内容', async (t) => {
  try {
    const { ctx, runtime, fetches, toolName } = await boot();
    ctx.on('tools/post-execute', async () => ({ kind: 'block', feedback: [{ type: 'text', text: '下游拦截' }] }));
    const final = await runPipeline(ctx, toolName);
    assert.equal(final.isError, true);
    assert.equal(final.content?.[0]?.text, '下游拦截');
    assert.equal(imageCount(final), 0);
    assert.equal(fetches(), 0, 'block 时不得抓图');
  } catch (error) {
    if (/找不到 DSH asar/u.test(String(error.message))) { t.skip('本机没有 DSH asar，跳过真实宿主夹具'); return; }
    throw error;
  }
});

test('下游自带 content：不被覆盖，也不抓图', async (t) => {
  try {
    const { ctx, runtime, fetches, toolName } = await boot();
    ctx.on('tools/post-execute', async () => ({ kind: 'accept', content: [{ type: 'text', text: '下游已改写' }] }));
    const final = await runPipeline(ctx, toolName);
    assert.equal(final.content.length, 1);
    assert.equal(final.content[0].text, '下游已改写');
    assert.equal(imageCount(final), 0);
    assert.equal(fetches(), 0);
  } catch (error) {
    if (/找不到 DSH asar/u.test(String(error.message))) { t.skip('本机没有 DSH asar，跳过真实宿主夹具'); return; }
    throw error;
  }
});

test('下游 accept 带 value：插件不得同时产出 content（否则宿主抛 TypeError）', async (t) => {
  try {
    const { ctx, runtime, toolName } = await boot();
    ctx.on('tools/post-execute', async () => ({ kind: 'accept', value: [{ type: 'text', text: '替换值' }] }));
    const final = await runPipeline(ctx, toolName);
    assert.equal(final.isError, false, '不得因为 value+content 冲突变成错误结果');
    assert.equal(imageCount(final), 0);
  } catch (error) {
    if (/找不到 DSH asar/u.test(String(error.message))) { t.skip('本机没有 DSH asar，跳过真实宿主夹具'); return; }
    throw error;
  }
});

test('无图帖子：最终 content 与原始一致，不抓图', async (t) => {
  try {
    const { ctx, runtime, fetches, toolName } = await boot({ withImage: false });
    const final = await runPipeline(ctx, toolName);
    assert.equal(final.content.length, 1);
    assert.equal(imageCount(final), 0);
    assert.equal(fetches(), 0);
  } catch (error) {
    if (/找不到 DSH asar/u.test(String(error.message))) { t.skip('本机没有 DSH asar，跳过真实宿主夹具'); return; }
    throw error;
  }
});

test('生产同形装配：按 inject 声明在 Cordis 作用域加载，真实 attachments 服务下附图', async (t) => {
  try {
    const { Context, Service, ToolRuntime, defineContentToolFixture } = await loadHostToolRuntime();
    class FakePrompt extends Service {
      constructor(ctx) { super(ctx, 'systemPrompt', true); }
      tools() { return { dispose() {} }; }
      section() { return { dispose() {} }; }
      getSectionOrder() { return 0; }
    }
    const ctx = new Context();
    ctx.plugin(FakePrompt);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const saved = [];
    ctx.provide('llm', {
      async resolveModelInfo(provider, model) { return { provider, model, inputModalities: ['text', 'image'] }; },
    });
    ctx.provide('attachments', {
      async saveImages(inputs) {
        return inputs.map((input, index) => {
          saved.push({ mediaType: input.mediaType, bytes: input.data.byteLength });
          return { attachmentId: 'scoped-' + (index + 1), mediaType: input.mediaType, bytes: input.data.byteLength };
        });
      },
    });
    const runtime = new ToolRuntime(ctx, { mode: 'native' });
    runtime.register(defineContentToolFixture({
      name: FULL('get_post_detail'),
      description: '离线帖子详情',
      parameters: {},
      async execute() { return [{ type: 'text', text: detailText(true) }]; },
    }));

    const guardModule = await import('../plugins/xhh-quota-guard/index.mjs');
    let applied = 0;
    const scoped = {
      name: 'xhh-guard-scoped-fixture',
      inject: guardModule.inject,
      apply(scopedCtx, config) {
        applied += 1;
        return guardModule.applyWithDeps(scopedCtx, config, {
          fetchBuffer: async () => ({ buffer: PNG, contentType: 'image/png' }),
        });
      },
    };
    ctx.plugin(scoped, {
      enabled: true,
      timeoutMs: 500,
      authorize: makeClient().authorize,
      commit: makeClient().commit,
      abort: makeClient().abort,
      complete: makeClient().complete,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(applied, 1, '插件应通过 Cordis 作用域装配一次');
    assert.deepEqual(guardModule.inject, ['tools'], 'inject 声明必须与生产一致');

    const final = await runPipeline(ctx, FULL('get_post_detail'));
    assert.equal(imageCount(final), 1, '作用域装配下仍应产出 1 个图片块');
    assert.ok(final.content.find((item) => item?.type === 'image')?.attachment?.attachmentId?.startsWith('scoped-'));
    assert.equal(saved.length, 1);
  } catch (error) {
    if (/找不到 DSH asar/u.test(String(error.message))) { t.skip('本机没有 DSH asar，跳过真实宿主夹具'); return; }
    throw error;
  }
});

test('attachments 服务后置提供：加载时缺失不报错，提供服务后附图', async (t) => {
  try {
    const { Context, Service, ToolRuntime, defineContentToolFixture } = await loadHostToolRuntime();
    class FakePrompt extends Service {
      constructor(ctx) { super(ctx, 'systemPrompt', true); }
      tools() { return { dispose() {} }; }
      section() { return { dispose() {} }; }
      getSectionOrder() { return 0; }
    }
    const ctx = new Context();
    ctx.plugin(FakePrompt);
    await new Promise((resolve) => setTimeout(resolve, 10));
    ctx.provide('llm', {
      async resolveModelInfo(provider, model) { return { provider, model, inputModalities: ['image'] }; },
    });
    // 关键：先不提供 attachments，模拟宿主后起。
    const runtime = new ToolRuntime(ctx, { mode: 'native' });
    runtime.register(defineContentToolFixture({
      name: FULL('get_post_detail'),
      description: '离线帖子详情',
      parameters: {},
      async execute() { return [{ type: 'text', text: detailText(true) }]; },
    }));
    applyWithDeps(ctx, { enabled: true, timeoutMs: 500, ...makeClient() }, {
      fetchBuffer: async () => ({ buffer: PNG, contentType: 'image/png' }),
    });

    const before = await runPipeline(ctx, FULL('get_post_detail'));
    assert.equal(imageCount(before), 0, '附件存储缺席时不得产出图片块');
    const noteBefore = (before.content ?? []).filter((item) => item?.type === 'text').map((item) => item.text).join('');
    assert.ok(noteBefore.includes('未提供附件存储'), '必须如实说明缺席原因，而不是静默');

    ctx.provide('attachments', {
      async saveImages(inputs) {
        return inputs.map((input, index) => ({ attachmentId: 'late-' + (index + 1), mediaType: input.mediaType }));
      },
    });
    const after = await runPipeline(ctx, FULL('get_post_detail'));
    assert.equal(imageCount(after), 1, '服务后起后应能附图');
  } catch (error) {
    if (/找不到 DSH asar/u.test(String(error.message))) { t.skip('本机没有 DSH asar，跳过真实宿主夹具'); return; }
    throw error;
  }
});
