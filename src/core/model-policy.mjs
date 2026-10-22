/**
 * DSH 模型目录 / 档位覆盖的纯策略层。
 *
 * 这里只收「给定目录与输入，算出结果」的纯函数：模型目录视图的字段兜底
 * （modelCatalogProviders）、档位是否被目标模型真实声明（resolveEffortForModel）、
 * 覆盖表合并（nextOverrideTable / overrideTableOf），以及 HTTP 400 契约共用的
 * 输入校验小工具（httpFail / requireNonEmptyString / isPlainObject / CONV_KEY_RE）。
 *
 * 刻意**不**搬进来的部分（留在 bridge）：
 *   · loadModelCatalog —— 带 5s 超时与在途去重，是有状态 I/O；
 *   · buildDshModelsResponse —— 依赖那层缓存的降级语义；
 *   · catalogErrorMessage —— 依赖 redactSensitiveText 的凭据脱敏。
 * 因此本模块没有 fs / 网络 / 计时器 / 全局可变状态，可以离线直接测；
 * 也正因为如此，这里不允许偷偷改语义：函数体与桥接中的原实现逐行一致。
 *
 * 边界纪律：
 *   · 目录校验是 fail closed 的调用方责任：本模块只回答「未知 provider/model /
 *     未声明档位」，不替调用方兜底成某个默认值；
 *   · nextOverrideTable 返回新表，绝不原地改输入（内存与磁盘各算一次，两边必须同形）；
 *   · 显式 null = 删除字段（清空协议），省略 = 保持现值 —— 两者必须可区分。
 */

/** 覆盖表里允许出现的字段；null 是清空协议，不是「非法值」。 */
export const DSH_OVERRIDE_FIELDS = ['provider', 'model', 'reasoningEffort'];

/** 会话 key 的合法性：只接受 private:<正整数> / group:<正整数>，不做 trim、不认前导零。 */
export const CONV_KEY_RE = /^(private|group):[1-9][0-9]*$/;

/**
 * 与桥接既有约定一致：只要是非 null 的 object 且不是数组就算「对象」。
 * 这是宽松判定（不检查原型），调用方据此决定是否按对象逐字段合并。
 */
export const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * DeepSeek provider 明确支持的取值（见 dsh-llm-deepseek：其它值会抛 UNSUPPORTED_REASONING_EFFORT）。
 * 'off' 虽然合法（关闭思考），但 QQ 聊天助手依赖思考，控制台不提供该档。
 * 顺序与取值都不许改：这是旧调用的兼容档位表，不新增档位。
 */
export const REASONING_EFFORT_OPTIONS = ['low', 'high', 'max'];

/**
 * 带 HTTP 状态码的错误：外层 catch 据此回 400/503…（与 readBody 的 err.statusCode 同一约定）。
 * 返回错误而不是直接 throw，调用点可以写成 `throw httpFail(...)`，栈从调用点开始。
 */
export function httpFail(status, message) {
  const error = new Error(message);
  error.statusCode = status;
  return error;
}

/** 非空字符串（首尾空白会去掉；空串 / 非字符串一律 400）。 */
export function requireNonEmptyString(value, label) {
  if (typeof value !== 'string') {
    throw httpFail(400, `${label} 必须是字符串（收到 ${value === null ? 'null' : typeof value}）`);
  }
  const trimmed = value.trim();
  if (!trimmed) throw httpFail(400, `${label} 不能是空字符串`);
  return trimmed;
}

/**
 * 目录 groups → A① 的 providers。字段缺失策略（不伪造能力，只做显示兜底）：
 *   · provider/model/effort 的 id 必须是非空字符串，否则该项丢弃（无法定位，显示了也选不了）；
 *   · name 缺失时显示 id（schema 里 name 必有，这里只是防老版本/异常目录）；
 *   · effort.description 缺失用空串，defaultEffort 缺失用 null（= 让 TUI 留空/跟随）；
 *   · 模型没有 reasoning（或 efforts 为空）时仍回 `{efforts:[], defaultEffort:null}`，
 *     让 TUI 能明确显示「该模型不支持思考强度」，而不是把模型整个丢掉；
 *   · 一个模型都没有的 provider 不返回（没有任何可选内容），但其余 provider 照常保留。
 * 纯读取：不修改 catalog 的任何层级。
 */
export function modelCatalogProviders(catalog) {
  const groups = Array.isArray(catalog?.groups) ? catalog.groups : [];
  const providers = [];
  for (const group of groups) {
    const providerId = typeof group?.id === 'string' ? group.id : '';
    if (!providerId.trim()) continue;
    const models = [];
    for (const entry of Array.isArray(group.models) ? group.models : []) {
      const modelId = typeof entry?.id === 'string' ? entry.id : '';
      if (!modelId.trim()) continue;
      const reasoning = entry?.reasoning && typeof entry.reasoning === 'object' && !Array.isArray(entry.reasoning)
        ? entry.reasoning
        : null;
      const efforts = [];
      for (const effort of Array.isArray(reasoning?.efforts) ? reasoning.efforts : []) {
        const effortId = typeof effort?.id === 'string' ? effort.id : '';
        if (!effortId.trim()) continue;
        efforts.push({
          id: effortId,
          name: typeof effort.name === 'string' && effort.name.trim() ? effort.name : effortId,
          description: typeof effort.description === 'string' ? effort.description : ''
        });
      }
      models.push({
        id: modelId,
        name: typeof entry.name === 'string' && entry.name.trim() ? entry.name : modelId,
        reasoning: {
          efforts,
          defaultEffort: typeof reasoning?.defaultEffort === 'string' && reasoning.defaultEffort.trim()
            ? reasoning.defaultEffort
            : null
        }
      });
    }
    if (!models.length) continue;
    providers.push({
      id: providerId,
      name: typeof group.name === 'string' && group.name.trim() ? group.name : providerId,
      models
    });
  }
  return providers;
}

/**
 * 按补丁 / 删除算出新的覆盖表（纯函数：磁盘与内存各算一次，保证两边同形）。
 * 合并语义：只覆盖显式给出的字段，其余字段（例如历史遗留的 reasoningEffort）原样保留。
 * **显式 null = 删除该字段**（A③ 清空协议）：用于「切到无 default 的模型后不要残留旧档位」；
 * 省略字段仍然是「保持现值」（旧调用兼容）。两者必须区分，否则内存会继续带着旧模型档位。
 *
 * @param {object} baseTable 现有覆盖表；不是对象时按空表处理
 * @param {Map<string, object>} patch 每个会话的字段补丁（值里的 null 表示清空该字段）
 * @param {Iterable<string>} removals 要整条删除的会话 key
 * @returns {object} 全新对象；baseTable / patch 都不会被修改
 */
export function nextOverrideTable(baseTable, patch, removals) {
  const table = isPlainObject(baseTable) ? JSON.parse(JSON.stringify(baseTable)) : {};
  for (const [key, clean] of patch.entries()) {
    const prev = isPlainObject(table[key]) ? table[key] : {};
    const merged = {};
    const cleared = new Set();
    for (const field of DSH_OVERRIDE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(clean, field)) {
        if (clean[field] === null) { cleared.add(field); continue; }
        merged[field] = clean[field];
      } else if (prev[field] !== undefined) {
        merged[field] = prev[field];
      }
    }
    // 保险：prev 里的其它键（历史遗留）也原样带过去，绝不静默丢字段；
    // 但被 null 显式清掉的字段不能再从 prev 抄回来。
    for (const [k, v] of Object.entries(prev)) if (merged[k] === undefined && !cleared.has(k)) merged[k] = v;
    table[key] = merged;
  }
  for (const key of removals) delete table[key];
  return table;
}

/** 只读视图：返回配置里的覆盖表本体（调用方不得修改），形状不对时回空表。 */
export function overrideTableOf(source) {
  const table = source?.socialV2?.modelOverrides;
  return isPlainObject(table) ? table : {};
}

/**
 * A① 修订（t5）：档位是否被**目标模型**真实声明。
 *
 * 与 TUI 的协议 v1 一致：
 *   · 目录里该模型声明了 efforts ⇒ 只接受其中 id（大小写不敏感；回写目录里的规范写法）；
 *   · 该模型完全没有 reasoning 元数据（旧 DSH / 旧目录）⇒ 只兼容内置 low/high/max，
 *     保证旧调用与旧 38 例不变；
 *   · 明确声明了 reasoning（哪怕 efforts:[]）⇒ 不支持任何字符串档位（TUI 应发 null 清空）。
 * 返回 { ok:true, value }（value 是落盘/下发用的规范 id）或 { ok:false, reason }。
 * 纯函数：只读 catalog，不做任何写入，也不回退到「猜一个」。
 */
export function resolveEffortForModel(catalog, provider, model, raw) {
  const groups = Array.isArray(catalog?.groups) ? catalog.groups : [];
  const group = groups.find((g) => String(g?.id ?? '') === provider);
  if (!group) {
    const known = groups.map((g) => g?.id).filter(Boolean).join(' / ');
    return { ok: false, reason: `未知 provider「${provider}」：DSH 模型目录里只有 ${known || '(空)'}` };
  }
  const models = Array.isArray(group.models) ? group.models : [];
  const entry = models.find((m) => String(m?.id ?? '') === model);
  if (!entry) {
    const known = models.map((m) => m?.id).filter(Boolean).join(' / ');
    return { ok: false, reason: `未知 model「${model}」：${provider} 下只有 ${known || '(空)'}` };
  }
  const hasReasoning = Boolean(entry.reasoning) && typeof entry.reasoning === 'object' && !Array.isArray(entry.reasoning);
  const declared = (hasReasoning && Array.isArray(entry.reasoning.efforts) ? entry.reasoning.efforts : [])
    .map((e) => (typeof e?.id === 'string' ? e.id : ''))
    .filter(Boolean);
  const wanted = String(raw ?? '').trim();
  if (declared.length) {
    const hit = declared.find((id) => id.toLowerCase() === wanted.toLowerCase());
    if (!hit) {
      return { ok: false, reason: `思考强度「${wanted}」不在 ${provider}/${model} 声明的档位里（${declared.join(' / ')}）` };
    }
    return { ok: true, value: hit };
  }
  if (hasReasoning) {
    return { ok: false, reason: `${provider}/${model} 在目录里声明为不支持思考强度，无法设置「${wanted}」` };
  }
  const legacy = REASONING_EFFORT_OPTIONS.find((id) => id === wanted.toLowerCase());
  if (!legacy) {
    return { ok: false, reason: `目录没有声明 ${provider}/${model} 的思考档位，无法确认「${wanted}」是否合法（只兼容 ${REASONING_EFFORT_OPTIONS.join(' / ')}）` };
  }
  return { ok: true, value: legacy };
}
