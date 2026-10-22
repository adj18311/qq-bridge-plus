// Pure wake-policy seam extracted from src/bridge.js (HEAD ca43576).
//
// The seven functions below are verbatim transcriptions of the legacy bridge bodies:
//   normalizeSpeakerIdsV2, defaultWakeConfigV2, hasExplicitEndV2, isSleepingConfigV2,
//   preSleepWaitBlockedV2, computeWakeSafetyV2, wakePriorityV2.
// Clock and random are injected capabilities ({ now, random }) at the original execution points;
// config acquisition, persistence and scheduling stay in the bridge. No module-load side effects.
//
// The wake-priority table intentionally stays in the bridge: callers pass their own ordinary
// object so inherited lookup is preserved.

const EXPLICIT_END_RE =
  /(?:不聊了|不说了|晚安|睡了|先睡了|下了|先下了|拜拜|再见|走了|先走|撤了|去忙|忙了|下次再聊|下次聊|散了吧|结束|就到这|先这样|就这样吧|886|88|睡觉了|下班了|去洗澡|去吃饭了)/i;

export function normalizeSpeakerIds(value) {
  if (value === undefined || value === null) return [];
  const rawList = Array.isArray(value) ? value : String(value).split(/[,，\s]+/);
  const seen = new Set();
  const clean = [];
  for (const v of rawList) {
    const s = String(v ?? '').trim();
    if (!/^[1-9]\d*$/.test(s)) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    clean.push(s);
    if (clean.length >= 20) break;
  }
  return clean;
}

export function defaultWakeConfig(w, { now, random }) {
  const defaultMode = w.defaultMode === 'active' ? 'active' : 'diving';
  const defaultInfinite = w.recommendedDefaultInfinite !== false;
  const recMin = Number(w.recommendedSleepMinMs) || 300000;
  const recMax = Number(w.recommendedSleepMaxMs) || 7200000;
  let finiteMs = recMin + random() * Math.max(0, recMax - recMin);
  const hardMin = Math.max(0, Number(w.sleepMinMs) || 0);
  const hardMax = Number(w.sleepMaxMs) || 0;
  if (hardMin > 0 && finiteMs < hardMin) finiteMs = hardMin;
  if (hardMax > 0 && finiteMs > hardMax) finiteMs = hardMax;
  return {
    mode: defaultMode,
    infinite: defaultInfinite,
    sleepUntil: defaultInfinite ? null : new Date(now() + Math.round(finiteMs)).toISOString(),
    triggers: {
      atMention: w.recommendedAtMention !== false,
      nameMention: w.recommendedNameMention !== false,
      speakerIds: [],
      keywords: Array.isArray(w.recommendedKeywords) ? w.recommendedKeywords.map(String) : [],
      question: w.recommendedQuestion !== false,
      poke: w.recommendedPoke !== false,
      anyMessage: defaultMode === 'active',
      probability: Math.min(1, Math.max(0, Number(w.recommendedProbability) || 0))
    },
    batchWindowMs: Math.max(1000, Number(w.batchWindowMs) || 8000),
    lastWakeAt: 0,
    wakeCount: 0,
    noActionCount: 0,
    confirmedAt: 0,
    confirmedBy: 'default'
  };
}

export function hasExplicitEnd(st) {
  const recent = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
  const last = [...recent].reverse().find((m) => m && !m.isSelf);
  if (!last) return false;
  return EXPLICIT_END_RE.test(String(last.tail || last.plain || last.text || ''));
}

export function isSleepingConfig(wc) {
  if (!wc) return false;
  if (wc.mode === 'active' || wc.triggers?.anyMessage) return false;
  return true; // diving 且不是 anyMessage 都视为“沉睡/潜水”，需要先观察
}

export function preSleepWaitBlocked(st, w, { now }) {
  if (!st) return false;
  if (w.preSleepWaitEnabled === false) return false;
  if (hasExplicitEnd(st)) return false;
  const waitMs = Math.max(0, Number(w.preSleepWaitMs) || 300000);
  const at = now();
  // 已经连续安静满观察窗口：可以直接设置潜水。
  if ((st.lastIncomingAt || 0) && at - st.lastIncomingAt >= waitMs) return false;
  // 已经完整等过观察窗口且之后没有新消息：放行。
  if (st.preSleepWaitSatisfiedAt && (!st.lastIncomingAt || st.lastIncomingAt <= st.preSleepWaitSatisfiedAt)) return false;
  // 已经做过一次沉睡前观察（可能等到了新消息并已把新消息返回给 AI），只要 AI 之后没有参与、也没有更新的消息，就允许直接沉睡。
  if (st.preSleepWaitObservedAt && (!st.lastIncomingAt || st.lastIncomingAt <= st.preSleepWaitObservedAt)) return false;
  return true;
}

export function computeWakeSafety(wc, { now }) {
  const tr = wc?.triggers || {};
  const hard = wc?.mode === 'active' || tr.anyMessage || tr.atMention || tr.nameMention || tr.question || tr.poke ||
    (Array.isArray(tr.keywords) && tr.keywords.length > 0) ||
    normalizeSpeakerIds(tr.speakerIds).length > 0;
  const timed = !wc?.infinite && wc?.sleepUntil && Date.parse(wc.sleepUntil) > now();
  const soft = Number(tr.probability) > 0;
  const guaranteed = hard || timed || soft;
  const confirmedNum = Number(wc?.confirmedAt);
  const stale = !wc?.confirmedAt || !Number.isFinite(confirmedNum) || now() - confirmedNum > 24 * 60 * 60 * 1000;
  return { hard, timed, soft, guaranteed, stale };
}

export function wakePriority(reason, priorities) {
  const base = String(reason ?? '').split(':')[0];
  return priorities[base] ?? 0;
}

// 是否"直接针对 AI"的提问/挑战：提到 AI 相关词且带疑问/比较，或对"你"开火，或追问催促
export function isDirectedAtAi(textContent) {
  const lower = String(textContent ?? '').toLowerCase();
  const aiMention = /deepseek|claude|chatgpt|gpt|大肥鱼|小鲸鱼|鲸鱼|d指导|d老师|d师傅|深度求索|\bds\b|ai|人工智障|机器人|模型/.test(lower);
  const challenge = /强|弱|行不行|能不能|会不会|是不是|一半|水平|垃圾|废物|白嫖|菜|不如|厉害|赢|输|比.*强|比.*弱/.test(lower);
  const question = /[?？吗呢吧]|怎么|为什么|哪|谁/.test(lower);
  if (aiMention && (question || challenge)) return true;
  // "你/您" + 疑问/比较/挑战（放宽，避免漏掉"你有claude一半强吗"这类直接问）
  if (/(你|您).{0,10}(吗|呢|？|\?|怎么|是不是|能不能|行不行|有没有|有|没有|比|不如|强|弱|一半|厉害|垃圾|菜|赢|输)/.test(lower)) return true;
  if (/^(你|您)(是不是|行不行|能不能|会不会|觉得|有|没有)/.test(lower)) return true;
  // "你是...还是... / 你是...吗 / 你是...？"（如：你是人类还是ai、你是真人吗）
  if (/(你|您)是[^？?。！!]{0,14}(还是|或者|吗|么|？|\?)/.test(lower)) return true;
  // 追问/催促：AI 没回时的真人式催促
  if (/怎么不说话|人呢|回我|说话啊|理我|别装死|在不在|装死|说话/.test(lower)) return true;
  return false;
}

export function evaluateWakeTrigger(st, event, kind, textContent, plainContent, quoteTargetIsSelf, capabilities) {
  if (kind === 'private') return 'private';
  const tr = st.wakeConfig?.triggers ?? {};
  if (tr.anyMessage) return 'anyMessage';
  if (tr.atMention) {
    const atSelf = Array.isArray(event?.message) && event.message.some((seg) => seg?.type === 'at' && String(seg.data?.qq) === String(event?.self_id ?? ''));
    if (atSelf || quoteTargetIsSelf) return 'atMention';
  }
  if (tr.nameMention && capabilities.getNickname()) {
    const lower = String(textContent ?? '').toLowerCase();
    if (lower.includes('@' + capabilities.getNickname().toLowerCase()) || lower.includes(capabilities.getNickname().toLowerCase())) return 'nameMention';
  }
  if (Array.isArray(tr.keywords) && tr.keywords.length) {
    const lower = String(plainContent ?? '').toLowerCase();
    for (const kw of tr.keywords) {
      const kwStr = String(kw ?? '').toLowerCase();
      if (!kwStr) continue;
      // 短英文/数字关键词（如 DS/R1）用词边界匹配，避免 ADS/BDSM/DSL 误触发。
      if (/^[a-z0-9]+$/.test(kwStr) && kwStr.length <= 4) {
        if (new RegExp(`\\b${kwStr}\\b`, 'i').test(lower)) return `keyword:${kw}`;
      } else if (lower.includes(kwStr)) {
        return `keyword:${kw}`;
      }
    }
  }
  if (tr.question && isDirectedAtAi(plainContent)) return 'question';
  if (Array.isArray(tr.speakerIds) && tr.speakerIds.length) {
    const speakerId = String(event?.user_id ?? event?.sender?.user_id ?? '');
    if (speakerId && tr.speakerIds.some((id) => String(id) === speakerId)) {
      const senderLabel = event?.sender?.card || event?.sender?.nickname || speakerId;
      return `speaker:${senderLabel}`;
    }
  }
  if (Number(tr.probability) > 0 && capabilities.random() < Number(tr.probability)) return 'probability';
  return null;
}
