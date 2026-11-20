import { getQzoneDshSessionContext } from './session-context.mjs';
import { QZONE_MCP_TOOLS, validateQzoneMcpInput } from '../../src/core/qzone-mcp-contract.mjs';

const ACTIONS = Object.freeze(Object.keys(QZONE_MCP_TOOLS));

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeInput(action, args) {
  try {
    if (!isPlainObject(args)) return null;
    const schema = QZONE_MCP_TOOLS[action].inputSchema;
    const allowed = Object.keys(schema.properties);
    if (Object.keys(args).some((key) => !allowed.includes(key))) return null;
    const input = Object.fromEntries(allowed.filter((key) => Object.hasOwn(args, key)).map((key) => [key, args[key]]));
    return validateQzoneMcpInput(action, input) ? input : null;
  } catch {
    return null;
  }
}

function toDshValueSchema(schema, required = false) {
  if (Array.isArray(schema.oneOf)) {
    return { ...(required ? { required: true } : {}), oneOf: schema.oneOf.map((branch) => toDshValueSchema(branch)) };
  }
  const result = {};
  if (required) result.required = true;
  if (schema.type !== undefined) result.type = schema.type;
  if (schema.enum !== undefined) result.enum = schema.enum;
  if (schema.const !== undefined) result.const = schema.const;
  if (schema.type === 'array' && schema.items) result.items = toDshValueSchema(schema.items);
  if (schema.type === 'object') {
    result.additionalProperties = schema.additionalProperties === true;
    if (schema.properties) {
      const requiredNames = new Set(schema.required ?? []);
      result.properties = Object.fromEntries(Object.entries(schema.properties).map(([name, property]) =>
        [name, toDshValueSchema(property, requiredNames.has(name))]));
    }
  }
  return result;
}

function toDshParameters(contract) {
  const requiredNames = new Set(contract.inputSchema.required ?? []);
  return Object.fromEntries(Object.entries(contract.inputSchema.properties).map(([name, schema]) =>
    [name, toDshValueSchema(schema, requiredNames.has(name))]));
}

/**
 * Build the READ-ONLY diagnosis tool (t10).
 *
 * WHY IT EXISTS: five different internal refusals all answer `origin-unbound`, so after a real
 * incident (a standard-mode session whose `qzone_read_posts` was refused while the host's
 * `tool/call` demonstrably fired) there was no way to ask the plugin WHY. C9 added the facts to
 * `status()`, but nothing exposed them to the model, which is the only place the question is
 * asked from.
 *
 * WHY IT DOES NOT GO THROUGH `dispatchBound`: it exists to diagnose dispatch failures. Routing it
 * through the very gate being diagnosed would make it fail exactly when it is needed — and it
 * would inherit the origin binding it is meant to explain the absence of.
 *
 * WHAT IT CANNOT DO: it takes no argument, makes no platform request, writes nothing, and stores
 * nothing. It calls ONE injected callback and returns what that callback says. The snapshot is
 * built by `createQzoneDiagnoseSnapshot` in `index.mjs`, which projects an allowlist of
 * non-identifying fields — so this file never sees, and the model never receives, a session id, a
 * call id, a QQ number, a token or any message body.
 *
 * @param diagnose - `() => object`, the snapshot provider. Already validated by the caller.
 * @param defineTool - the host's tool factory.
 * @param isActive - `() => boolean`, the same liveness latch every other tool uses.
 */
function makeDiagnoseTool(diagnose, defineTool, isActive) {
  return defineTool({
    name: 'qzone_diagnose',
    description: '只读诊断：报告 QQ 空间插件的调度就绪状态与最近一次拒绝原因，不访问平台、不写存储',
    // No parameters at all: there is nothing to ask it that the snapshot does not already carry,
    // and an empty schema makes that visible to the model.
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute() {
      // Deliberately does NOT require a session context: the whole point is to work in the
      // situations where the dispatch path refuses for lack of one.
      if (!isActive()) return { ok: false, error: 'tool-unavailable' };
      try {
        return diagnose();
      } catch {
        // A diagnostic that throws is useless to the caller and must not look like a plugin fault.
        return { ok: false, error: 'diagnose-failed' };
      }
    },
  });
}

/**
 * Strip the internal `_images` field from what the MODEL reads.
 *
 * The value carries attachment references so `render` can emit image blocks; those refs are
 * meaningless as text and would be sent twice (once as JSON, once as the image itself), so the
 * text projection drops them. Every other field is passed through untouched — this is a
 * presentation filter, never a rewrite of the result.
 */
function stripInternalImageRefs(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  if (!Object.hasOwn(value, '_images')) return value;
  const { _images, ...rest } = value;
  void _images;
  return rest;
}

/**
 * Render one tool result: text first, then whatever image attachments were attached.
 *
 * The no-image case is BYTE-IDENTICAL to the previous renderer (`JSON.stringify(value)` in a single
 * text block) — a caller that never gets pictures sees no difference at all.
 */
function renderToolOutput(value, imagesEnabled) {
  const hasImages = imagesEnabled === true && Array.isArray(value?._images) && value._images.length > 0;
  const text = JSON.stringify(imagesEnabled === true ? stripInternalImageRefs(value) : value);
  if (!hasImages) return [{ type: 'text', text }];
  return [
    { type: 'text', text },
    ...value._images.map((ref) => ({ type: 'image', attachment: ref })),
  ];
}
/**
 * Per-action model-facing descriptions.
 *
 * ⚠️ WHY THIS IS A TABLE AND NOT ONE TEMPLATE (t45). Every qzone tool used to carry the same
 * line — "QQ空间 <action> 操作" — which told the model nothing it could not read off the name.
 * Measured cost, on a live session: the agent asked to see its own space's comments and spent a
 * whole turn reasoning "read_posts still doesn't return comments", because nothing in the catalog
 * said that a post read NEVER carries comments. It then reported "no read comments tool" while
 * `qzone_read_comments` was in its own tool list. Three wasted steps, one wrong answer.
 *
 * So each description now states what the tool returns, what it does NOT return, and what it
 * needs. Two facts are worth spelling out because they are the ones the model got wrong:
 *   · `read_posts` returns posts (content/time/images) and NEVER comments — that is a different
 *     tool, and it needs the post's `tid`, which is why `read_posts` is where you get one;
 *   · a read is limited to the LAST SEVEN DAYS of the target's own space, and only for an account
 *     that is a proven friend (or one the operator was explicitly pointed at). Saying so stops the
 *     model from retrying an older post that can never come back.
 */
const TOOL_DESCRIPTIONS = Object.freeze({
  read_posts: '读某个 QQ 号的空间说说列表。返回每条说说的正文、发布时间、以及图片（图片会作为真正的图像交给你看）。'
    + '【不含评论】——评论要用 qzone_read_comments，它需要先从这里拿到 tid。'
    + '【范围】只看最近 7 天；超出这个窗口的说说不会返回，重试也一样。'
    + '【前提】目标必须是好友，或是管理员明确让你去看的那条。'
    + '分页用 pos/num（num 最大 100）。',
  read_comments: '读某条说说下面的评论区（含楼中楼回复）。需要 tid（先说说的 id）与 target_uin（说说作者的 QQ）。'
    + '返回 parent（作者与帖子 id）与 comments 数组（id/author/time/content）。'
    + '【范围】只返回最近 7 天内的评论；更早的评论不会返回。'
    + '【前提】目标必须是好友。想读评论请先用 qzone_read_posts 拿到 tid。',
  publish: '发一条新说说。content 是正文，ugc_right 是可见范围（1=公开，其余见 schema）。'
    + '【限额】每 2 小时最多一条、每天最多 3 条；超额会被拒绝，不要立即重试。',
  comment: '在某条说说下发表评论。需要 tid、target_uin（说说作者）与 content。'
    + '【限额】每 3 分钟最多一条、每天最多 25 条。',
  reply: '回复某条已有评论。需要 tid、target_uin、comment_id、comment_uin 与 content。'
    + '【前提】只能回复你在最近 7 天内真正读过的那条评论。',
  like: '给某条说说点赞。需要 tid 与 target_uin。【限额】同一帖子只计一次，每天最多 30 次。',
});

function makeNativeTool(action, dispatch, defineTool, isActive, imageLoader) {
  const contract = QZONE_MCP_TOOLS[action];
  // Only `read_posts` can carry pictures; every other action keeps the plain JSON text shape.
  const images = action === 'read_posts' ? imageLoader : undefined;
  return defineTool({
    name: `qzone_${action}`,
    description: TOOL_DESCRIPTIONS[action],
    parameters: toDshParameters(contract),
    output: {
      // The declared shape stays `json`: the value is still the dispatch result plus one
      // `_images` array the renderer turns into image blocks. Declaring a new schema would
      // require the host to know about `_images`, and it deliberately does not.
      schema: { type: 'json' },
      render: (_args, value) => renderToolOutput(value, images !== undefined),
    },
    async execute(args, exec) {
      if (!isActive()) return { ok: false, error: 'tool-unavailable' };
      if (exec?.signal?.aborted) return { ok: false, error: 'call-cancelled' };
      const context = getQzoneDshSessionContext(exec);
      if (!context) return { ok: false, error: 'missing-native-context' };
      if (typeof dispatch !== 'function') return { ok: false, error: 'dispatch-unavailable' };
      const input = normalizeInput(action, args);
      if (!input) return { ok: false, error: 'invalid-input' };
      let result;
      try {
        result = await dispatch(action, input, context);
      } catch {
        return { ok: false, error: 'dispatch-failed' };
      }
      if (images === undefined || result === null || typeof result !== 'object') return result;
      // ⚠️ IMAGE ATTACHMENT IS BEST-EFFORT AND MUST NEVER CHANGE THE RESULT. Any failure inside
      // the loader is swallowed here: the read already happened and its text answer is what the
      // caller asked for. A thrown error would turn a successful space read into a failed tool
      // call, which is a strictly worse outcome than "no pictures this time".
      try {
        const loaded = await images(result, exec);
        if (Array.isArray(loaded) && loaded.length > 0) return { ...result, _images: loaded };
      } catch { /* no images this time */ }
      return result;
    },
  });
}

/**
 * Register the DSH native tool entry points. Every effect belongs to the injected dependencies.
 *
 * @param ctx - host context; `ctx.tools.register` must exist.
 * @param {object} deps
 * @param {Function} [deps.dispatch]  the business dispatcher the six `qzone_*` tools call.
 * @param {Function} [deps.defineTool]  the host's tool factory (defaults to `@deepseek-ai/dsh-tools`).
 * @param {() => object} [deps.diagnose]  OPTIONAL readonly snapshot provider. When supplied,
 *   `qzone_diagnose` is registered alongside the six business tools; when OMITTED it is not
 *   registered at all — a host that does not offer the snapshot gets exactly the previous surface,
 *   and a tool that could only answer "unavailable" is never advertised.
 * @param {(result: object, exec: object) => Promise<object[]>} [deps.imageLoader]  OPTIONAL
 *   image-attachment loader used ONLY by `qzone_read_posts`. When OMITTED the tool has no image
 *   path at all and returns text exactly as before — the host that cannot store attachments is
 *   the ordinary case, not a broken one.
 */
export async function applyQzoneNativeTools(ctx, { dispatch, defineTool, diagnose, imageLoader } = {}) {
  if (typeof ctx?.tools?.register !== 'function') {
    return { ok: false, error: 'tool-registration-unavailable' };
  }
  let factory = defineTool;
  if (factory === undefined) {
    try {
      ({ defineTool: factory } = await import('@deepseek-ai/dsh-tools'));
    } catch {
      return { ok: false, error: 'dsh-tools-unavailable' };
    }
  }
  if (typeof factory !== 'function') return { ok: false, error: 'invalid-tool-factory' };

  const disposers = [];
  let active = false;
  try {
    for (const action of ACTIONS) {
      const disposer = ctx.tools.register(makeNativeTool(action, dispatch, factory, () => active,
        typeof imageLoader === 'function' ? imageLoader : undefined));
      if (typeof disposer !== 'function') throw new Error('tool is not disposable');
      disposers.push(disposer);
    }
    // The diagnosis tool is OPT-IN: registered only when the caller supplied a snapshot provider.
    // It is registered AFTER the six business tools so a failure here cannot take them down, and
    // it is inside the same rollback scope so a partial registration still unwinds cleanly.
    if (typeof diagnose === 'function') {
      const diagnoseDisposer = ctx.tools.register(makeDiagnoseTool(diagnose, factory, () => active));
      if (typeof diagnoseDisposer !== 'function') throw new Error('tool is not disposable');
      disposers.push(diagnoseDisposer);
    }
    active = true;
  } catch {
    for (const dispose of [...disposers].reverse()) {
      try { dispose(); } catch {}
    }
    return { ok: false, error: 'tool-registration-failed' };
  }
  return {
    ok: true,
    dispose() {
      active = false;
      for (const dispose of [...disposers].reverse()) {
        try { dispose(); } catch {}
      }
    },
  };
}
