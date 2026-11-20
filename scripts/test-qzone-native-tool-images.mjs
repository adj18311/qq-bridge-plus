// t32 — `qzone_read_posts` must hand the model PICTURES, not URLs.
//
// THE PROBLEM, MEASURED
// --------------------
// The read chain already returns `posts[].images` (https links on the Tencent photo store, already
// allowlisted by the projection). A model cannot dereference a URL, and the agent said so plainly:
// "只给了地址，我这边读不了图". So the plugin downloads a small, strictly bounded number of them and
// attaches them to the tool result — the same mechanism DSH's own `read_image` uses.
//
// WHAT IS REAL HERE
// -----------------
//   · the REAL plugin entry, the REAL `applyQzoneNativeTools` registration, the REAL renderer;
//   · the REAL `post-images.mjs` loader, including magic-byte sniffing and the size cap.
// WHAT IS A FIXTURE: the Cordis context, the runtime's `dispatch`, the attachment service and
// `fetchImage`. NOTHING HERE TOUCHES THE NETWORK.
//
// ⚠️ REAL HOST NOT RESTARTED. This proves the tool emits image blocks with attachment references
// and degrades to text without an attachment service. It does NOT prove a real DSH renders them in
// a real session — that needs one live run.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createQzonePluginHandle } from '../plugins/qzone-safe/index.mjs';
import { applyQzoneNativeTools } from '../plugins/qzone-safe/native-tool.mjs';
import {
  createQzoneImageLoader,
  selectImageUrls,
  sniffImageMediaType,
} from '../plugins/qzone-safe/post-images.mjs';
import { createQzoneOriginLedger } from '../src/core/qzone-origin-ledger-offline.mjs';

const SESSION = 'session-images';
const CALL_ID = 'call-images';
const EPOCH = 'epoch-images';
const FRIEND = 20007;

/** Real magic bytes for each supported container. */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const WEBP = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
const GIF = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00]);
const NOT_AN_IMAGE = Buffer.from('this is definitely not an image at all', 'utf8');

function fakeCtx(services = {}) {
  const listeners = new Map();
  const registered = new Map();
  const ctx = {
    on(event, listener) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return () => {};
    },
    tools: {
      register(tool) {
        registered.set(tool.name, tool);
        return () => registered.delete(tool.name);
      },
    },
    // The host's optional service lookup. `get` THROWS for an unknown name in real Cordis, which
    // is why the plugin wraps it in try/catch; this double reproduces that.
    get(name) {
      if (Object.hasOwn(services, name)) return services[name];
      throw new Error('unknown service ' + name);
    },
  };
  const emit = (event, ...args) => { for (const listener of listeners.get(event) ?? []) listener(...args); };
  return { ctx, registered, emit };
}

/** An attachment service that records what it was asked to store. */
function fakeAttachments() {
  const saved = [];
  return {
    saved,
    async saveImage({ data, mediaType, name }) {
      saved.push({ bytes: data.length, mediaType, name });
      return Object.freeze({
        attachmentId: 'att-' + saved.length,
        mediaType,
        bytes: data.length,
        width: 640,
        height: 480,
        name,
      });
    },
  };
}

/** A dispatch double: `read_posts` returns the given posts, every other action a marker. */
/**
 * The runtime double. `getLedger` mints a REAL origin ledger so the plugin's own observe/consume
 * bookkeeping is real; only `dispatch` is faked, and it is the LAST hop (the platform call), not
 * the gate.
 */
function fakeRuntime(posts, ledgers) {
  return {
    epoch: EPOCH,
    dispatch: async (action) => {
      if (action === 'read_posts') return { ok: true, outcome: 'success', posts };
      return { ok: true, outcome: 'success', wrote: action };
    },
    sourceLifetime: {
      sourceEpoch: () => EPOCH,
      getLedger(sessionId) {
        let ledger = ledgers.get(sessionId);
        if (ledger === undefined) {
          ledger = createQzoneOriginLedger({ sessionId, epoch: EPOCH });
          ledgers.set(sessionId, ledger);
        }
        return ledger;
      },
    },
  };
}

async function makeHandle(t, { posts = [], services = {}, imageDownloader } = {}) {
  const host = fakeCtx(services);
  const ledgers = new Map();
  const runtime = fakeRuntime(posts, ledgers);
  const handle = await createQzonePluginHandle(host.ctx, { enabled: true }, {
    epoch: runtime.epoch, dispatch: runtime.dispatch, sourceLifetime: runtime.sourceLifetime,
    defineTool: (tool) => tool,
    // Injected so the suite opens NO socket: production uses safeFetchBuffer.
    ...(imageDownloader === undefined ? {} : { imageDownloader }),
  });
  t.after(async () => { await handle.dispose(); });
  return { host, handle, ledgers };
}

const EXEC = Object.freeze({ callId: CALL_ID, agent: Object.freeze({ session: Object.freeze({ id: SESSION }) }) });

/**
 * Give the plugin the ORIGIN evidence it needs, then call the tool.
 *
 * `dispatchBound` refuses every call it holds no position for — that is the whole point of the
 * origin ledger — so a tool executed without this answers `origin-unbound` and NEVER reaches the
 * image path. This fixture is the same one `test-qzone-plugin-assembly.mjs` uses (the host
 * announces the events; everything downstream is the plugin's own code).
 *
 * ONE turn/step/callId per call: the ledger accepts one binding per (turn, step) and one use of
 * each callId, so reusing them would turn the second call into a replay refusal instead of a read.
 */
let callSeq = 0;
async function callTool({ host, handle, ledgers }, name, args) {
  callSeq += 1;
  const callId = CALL_ID + '-' + callSeq;
  const requestId = 'rpc-' + callSeq;
  // THE HOST SIDE OF THE FIXTURE: announce the agent so the plugin installs its pre-step adapter.
  // Going around this (calling the ledger directly) leaves the plugin with no adapter, and then
  // `dispatchBound` answers `origin-unbound` for a call the ledger would happily have accepted —
  // which is precisely the production incident C8/C9 were about.
  const preStep = [];
  host.emit('agent/created', { agent: {
    id: 'agent-' + callSeq, session: { id: SESSION },
    ctx: { on: (event, listener) => { if (event === 'agent/pre-step') preStep.push(listener); return () => {}; } },
  } });
  if (preStep.length === 0) throw new Error('fixture: the plugin installed no pre-step adapter');
  handle.registerBridgeRequest(SESSION, { requestId, origin: 'qq-inbound' });
  for (const listener of preStep) {
    listener({ turn: callSeq, step: 1, messages: [{ role: 'user', source: { rpcId: requestId } }] }, () => {});
  }
  host.emit('session/event', { id: SESSION },
    { type: 'tool/call', data: { turn: callSeq, step: 1, callId, name } });
  const result = await host.registered.get(name).execute(args,
    { callId, agent: { session: { id: SESSION } } });
  // CLOSE THE TURN, as the host does when a model turn finishes.
  //
  // The ledger refuses to open a second turn while one is still in flight (that is deliberate:
  // a forward jump with no end looks like lost evidence, and latching `continuityLost` there is
  // what keeps replay detection honest). Without this line the SECOND call in a test would be
  // refused for a reason that has nothing to do with images — measured while writing these tests:
  // call 1 → publish, call 2 → `origin-unbound` with `reason: 'consume'`.
  const ledger = ledgers.get(SESSION);
  if (ledger && ledger.endTurn({ sessionId: SESSION, turn: callSeq }) !== true) {
    throw new Error('fixture: the ledger refused to end turn ' + callSeq);
  }
  return result;
}

/** One post with pictures, timestamped newest so it is the post the loader should inspect. */
function postWithImages(images, extra = {}) {
  return { author: '456', id: 'p-new', time: Date.parse('2026-11-17T00:00:00Z'),
    content: 'with pictures', images, ...extra };
}

// ── 1. no attachment service ⇒ text only, no request, no throw ─────────────────────────────
test('IMG-T1 无 attachments 服务 ⇒ 只返回文字、不发任何下载请求、不抛错', async (t) => {
  let fetched = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetched += 1; throw new Error('must not be called'); };
  t.after(() => { globalThis.fetch = originalFetch; });

  const posts = [postWithImages(['https://img.example/a.jpg'])];
  const harness = await makeHandle(t, { posts });
  const tool = harness.host.registered.get('qzone_read_posts');
  const result = await callTool(harness, 'qzone_read_posts', { target_uin: FRIEND });

  assert.equal(result.ok, true, '读仍然必须成功');
  assert.equal(Object.hasOwn(result, '_images'), false, '没有附件服务时不得出现 _images 字段');
  assert.equal(fetched, 0, '★ 没有附件服务时不得发起任何下载');
  // The renderer must be byte-identical to the pre-t32 shape: ONE text block, nothing else.
  const blocks = tool.output.render({}, result);
  assert.equal(blocks.length, 1, '无图时渲染结果必须只有一个文本块');
  assert.equal(blocks[0].type, 'text');
  assert.deepEqual(JSON.parse(blocks[0].text), result, '文本块必须是完整结果（无图时没有内部字段可剔除）');
});

// ── 2. attachments + fake fetch ⇒ image blocks, and `_images` never reaches the text ────────
test('IMG-T2 有 attachments + 假 fetch ⇒ 生成图像块，且 text 里不含 _images', async (t) => {
  const attachments = fakeAttachments();
  const downloads = [];
  // The loader now takes a DOWNLOADER that returns bytes (the host's SSRF-guarded fetcher),
  // not a bare fetch: the type is sniffed from magic bytes either way.
  const downloadImage = async (url) => { downloads.push(url); return new Uint8Array(JPEG); };
  // Drive the REAL loader; the plugin wiring is covered by IMG-T5.
  const loader = createQzoneImageLoader({ attachments, downloadImage });
  const posts = [postWithImages([
    'https://img.example/1.jpg', 'https://img.example/2.jpg',
    'https://img.example/3.jpg', 'https://img.example/4.jpg',
  ])];
  const harness = await makeHandle(t, { posts, services: { attachments }, imageDownloader: downloadImage });
  const tool = harness.host.registered.get('qzone_read_posts');

  // The plugin builds its OWN loader from `ctx.get('attachments')` + safeFetchBuffer. The
  // harness injects a fake downloader instead, so NO network call can happen; the code path is
  // otherwise identical.

  const result = await callTool(harness, 'qzone_read_posts', { target_uin: FRIEND });
  assert.equal(result.ok, true);
  assert.equal(Array.isArray(result._images), true, '必须带上 _images');
  assert.equal(result._images.length, 3, '★ 每次最多 3 张（第 4 张必须被丢弃）');
  assert.equal(downloads.length, 3, '第 4 个 URL 不得被下载');
  for (const ref of result._images) {
    assert.equal(typeof ref.attachmentId, 'string', '每个 ref 必须带 attachmentId');
    assert.equal(ref.mediaType, 'image/jpeg', 'mediaType 必须由魔数判定');
  }

  const blocks = tool.output.render({}, result);
  assert.equal(blocks.filter((block) => block.type === 'image').length, 3, '★ 必须渲染出 3 个 image 块');
  const text = blocks[0].text;
  assert.equal(text.includes('_images'), false, '★ 给模型看的 text 里不得出现 _images');
  assert.equal(text.includes('attachmentId'), false, '★ 附件 id 是内部引用，不得出现在 text 里');
  const parsed = JSON.parse(text);
  assert.deepEqual(parsed.posts, posts, '文本里必须仍然有完整的 posts');
  assert.equal(parsed.ok, true, '文本必须是完整的 dispatch 结果');
  assert.equal(Object.hasOwn(parsed, '_images'), false, '剔除必须是真的剔除，而不是改成 null');

  // The loader used directly produces the same shape (proves the fixture is not masking a bug).
  const direct = await loader({ posts }, EXEC);
  assert.equal(direct.length, 3);
});

// ── 3. every failure mode skips silently ────────────────────────────────────────────────────
test('IMG-T3 下载失败/超时/超限/魔数不对 ⇒ 静默跳过该张，其余照常，整体仍 ok', async (t) => {
  const attachments = fakeAttachments();
  // The downloader reports every failure by THROWING (that is what safeFetchBuffer does: an
  // HTTP error, an oversized body and a redirect refusal all throw). A wrong-typed or empty body
  // is the only in-band case, and the loader rejects it too.
  const cases = {
    throws: async () => { throw new Error('network down'); },
    http500: async () => { throw new Error('图片抓取失败：HTTP 500'); },
    notAnImage: async () => new Uint8Array(NOT_AN_IMAGE),
    tooBig: async () => { throw new Error('图片过大'); },
    empty: async () => new Uint8Array(0),
    notBytes: async () => 'not-bytes',
  };
  for (const [label, downloadImage] of Object.entries(cases)) {
    const loader = createQzoneImageLoader({ attachments, downloadImage });
    const refs = await loader({ posts: [postWithImages(['https://img.example/x.jpg'])] }, EXEC);
    assert.deepEqual(refs, [], label + ' 必须被静默跳过（空数组，不抛错）');
  }
  assert.equal(attachments.saved.length, 0, '★ 没有任何一张被存成附件');

  // A partial failure keeps the good ones: 1st breaks, 2nd is a PNG.
  let call = 0;
  const mixed = createQzoneImageLoader({ attachments, downloadImage: async () => {
    call += 1;
    if (call === 1) throw new Error('down');
    return new Uint8Array(PNG);
  } });
  const refs = await mixed({ posts: [postWithImages([
    'https://img.example/broken.jpg', 'https://img.example/ok.png',
  ])] }, EXEC);
  assert.equal(refs.length, 1, '坏的那张被跳过，好的那张仍然返回');
  assert.equal(refs[0].mediaType, 'image/png');
});

// ── 4. other tools are untouched ────────────────────────────────────────────────────────────
test('IMG-T4 read_posts 之外的工具行为不变：无 _images、渲染仍是单个文本块', async (t) => {
  const attachments = fakeAttachments();
  let fetched = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetched += 1; return new Response(JPEG, { status: 200 }); };
  t.after(() => { globalThis.fetch = originalFetch; });

  const harness = await makeHandle(t, { services: { attachments } });
  // EXACTLY the fields each contract declares: the tool rejects any unknown key as `invalid-input`,
  // so a shared superset would prove nothing about the action being exercised.
  const CASES = {
    qzone_publish: { content: 'x', ugc_right: 1 },
    qzone_comment: { tid: 'p1', target_uin: FRIEND, content: 'x' },
    qzone_like: { tid: 'p1', target_uin: FRIEND },
    qzone_reply: { tid: 'p1', target_uin: FRIEND, content: 'x', comment_id: 'c1', comment_uin: 7 },
  };
  for (const [name, args] of Object.entries(CASES)) {
    const tool = harness.host.registered.get(name);
    const result = await callTool(harness, name, args);
    assert.equal(result.ok, true, name + ' 的 dispatch 结果必须照常返回');
    assert.equal(Object.hasOwn(result, '_images'), false, name + ' 不得带 _images');
    const blocks = tool.output.render({}, result);
    assert.equal(blocks.length, 1, name + ' 的渲染必须是单个文本块');
    assert.equal(blocks[0].type, 'text');
  }
  assert.equal(fetched, 0, '★ 非 read_posts 的工具不得发起任何下载');
});

// ── 5. the plugin wiring itself: ctx.get('attachments') is optional ─────────────────────────
test('IMG-T5 插件装配：有 attachments 服务时 read_posts 带上图片，服务 get 抛错时优雅降级', async (t) => {
  // (a) the service exists -> the loader is built and used.
  //
  // The downloader is INJECTED: production's default is `safeFetchBuffer`, which refuses
  // loopback/LAN/link-local targets. This case is about the WIRING (does the plugin build a
  // loader from `ctx.get('attachments')` and call it?), so the download itself is a double —
  // which also proves the suite opens no socket.
  const attachments = fakeAttachments();
  let downloads = 0;
  const downloadImage = async () => { downloads += 1; return new Uint8Array(GIF); };
  const posts = [postWithImages(['https://img.example/a.gif'])];
  const withService = await makeHandle(t, { posts, services: { attachments }, imageDownloader: downloadImage });
  const okResult = await callTool(withService, 'qzone_read_posts', { target_uin: FRIEND });
  assert.equal(okResult._images?.length, 1, '有附件服务时 read_posts 必须带上图片');
  assert.equal(okResult._images[0].mediaType, 'image/gif', 'mediaType 必须由魔数判定为 gif');
  assert.equal(downloads, 1, '有服务时应当恰好下载一次');

  // (b) `ctx.get` throws (unknown service) -> text only, no error, no request.
  const without = await makeHandle(t, { posts, imageDownloader: downloadImage });
  const before = downloads;
  const degraded = await callTool(without, 'qzone_read_posts', { target_uin: FRIEND });
  assert.equal(degraded.ok, true, '缺服务时读必须仍然成功');
  assert.equal(Object.hasOwn(degraded, '_images'), false, '缺服务时不得带 _images');
  assert.equal(downloads, before, '★ 缺服务时不得发起下载');
});

// ── 6. the pure helpers, pinned directly ────────────────────────────────────────────────────
test('IMG-T6 魔数嗅探与候选挑选：只认四种容器、只取最新一条说说、最多 3 张', () => {
  assert.equal(sniffImageMediaType(JPEG), 'image/jpeg');
  assert.equal(sniffImageMediaType(PNG), 'image/png');
  assert.equal(sniffImageMediaType(WEBP), 'image/webp');
  assert.equal(sniffImageMediaType(GIF), 'image/gif');
  assert.equal(sniffImageMediaType(NOT_AN_IMAGE), null, '无法识别必须返回 null（跳过），不得猜测');
  assert.equal(sniffImageMediaType(Buffer.from([0xff, 0xd8])), null, '过短必须返回 null');
  // Content-Type is NOT consulted: a PNG body declared as jpeg is still a PNG.
  assert.equal(sniffImageMediaType(PNG), 'image/png');

  const posts = [
    { id: 'old', time: 1000, images: ['https://img.example/old.jpg'] },
    { id: 'new', time: 2000, images: [
      'https://img.example/1.jpg', 'https://img.example/2.jpg',
      'https://img.example/3.jpg', 'https://img.example/4.jpg',
    ] },
    { id: 'middle', time: 1500, images: ['https://img.example/mid.jpg'] },
  ];
  assert.deepEqual(selectImageUrls({ posts }),
    ['https://img.example/1.jpg', 'https://img.example/2.jpg', 'https://img.example/3.jpg'],
    '★ 只取最新一条说说的图，且最多 3 张');

  // Non-http(s) schemes are dropped before any download is attempted.
  assert.deepEqual(selectImageUrls({ posts: [{ id: 'x', time: 1, images: [
    'javascript:alert(1)', 'data:image/png;base64,xx', 'file:///etc/passwd', 'https://img.example/ok.jpg',
  ] }] }), ['https://img.example/ok.jpg'], '只有 http/https 的 URL 可以进入下载队列');

  assert.deepEqual(selectImageUrls({ posts: [] }), [], '空列表');
  assert.deepEqual(selectImageUrls({}), [], '没有 posts 时返回空数组而不是抛错');
  assert.deepEqual(selectImageUrls({ posts: [{ id: 'x', time: 1 }] }), [], '没有 images 字段时返回空数组');
});

// ── 7. the DEFAULT downloader is the SSRF-guarded fetcher (real bug found in review) ─────────
test('IMG-T7 默认下载器走 safeFetchBuffer：拒绝环回/链路本地/内网，一张都取不到', async () => {
  // The URLs in `posts[].images` are written by ANOTHER QQ account (the post author). A bare
  // `fetch` here would let that account point this process at 127.0.0.1, 169.254.169.254 or a
  // LAN host and read the response back through the model. The plugin therefore injects
  // `safeFetchBuffer`; this case pins that the GUARD is what runs.
  const { safeFetchBuffer } = await import('../src/safe-fetch.js');
  const blocked = [
    'http://127.0.0.1:13000/api/qzone/onebot',
    'http://169.254.169.254/latest/meta-data/',
    'http://192.168.1.1/admin',
    'http://[::1]/',
    'http://10.0.0.1/',
    'file:///etc/passwd',
  ];
  for (const url of blocked) {
    await assert.rejects(() => safeFetchBuffer(url, 1024 * 1024, { allowRedirect: false }),
      (error) => error instanceof Error, url + ' 必须被安全下载器拒绝');
  }
  // With the production downloader wired in, a post whose images point at private targets yields
  // NO attachments and does not throw.
  const attachments = fakeAttachments();
  const downloadImage = async (url, { maxBytes }) => {
    const result = await safeFetchBuffer(url, maxBytes, { allowRedirect: false });
    return result.buffer;
  };
  const loader = createQzoneImageLoader({ attachments, downloadImage });
  const refs = await loader({ posts: [postWithImages(blocked.filter((u) => u.startsWith('http')))] }, EXEC);
  assert.deepEqual(refs, [], '★ 私网/环回目标必须一张都取不到');
  assert.equal(attachments.saved.length, 0, '★ 不得把任何私网响应存成附件');
});


// ── 8. the download step has ONE total budget, not one per image ─────────────────────────────
test('IMG-T8 三张图共享一个总预算：累计超时后剩余的不再下载，读仍然成功', async () => {
  // Sequential 10 s-per-image would block a successful read for up to 30 s. The point of the
  // picture is that it rides along with an answer that ALREADY exists, so the whole step gets one
  // deadline and gives up on whatever it did not reach.
  const attachments = fakeAttachments();
  let clock = 0;
  let downloads = 0;
  const downloadImage = async () => {
    downloads += 1;
    clock += 6_000;   // every download "takes" 6 s of the shared 12 s budget
    return new Uint8Array(JPEG);
  };
  const loader = createQzoneImageLoader({ attachments, downloadImage, now: () => clock });
  const refs = await loader({ posts: [postWithImages([
    'https://img.example/1.jpg', 'https://img.example/2.jpg', 'https://img.example/3.jpg',
  ])] }, EXEC);
  assert.ok(refs.length < 3, '★ 累计超预算后必须提前停手（实际取到 ' + refs.length + ' 张）');
  assert.ok(downloads <= 3, '★ 不得超出候选数量');
});
