// Frozen historical oracle for the wake-trigger extraction (stage wake-trigger-20261018).
//
// Taken mechanically from the CURRENT DIRTY WORKSPACE baseline (not from HEAD ca43576, which would
// omit the uncommitted wake-policy stage):
//   src/bridge.js sha256 C14FC28A7EB00F296D1B8B121C18D88DD93898AC21AE9314D2BA4586691D4522
//
// Only mechanical substitutions were made:
//   isDirectedAtAi                -> legacyIsDirectedAtAi
//   evaluateWakeTriggerV2         -> legacyEvaluateWakeTrigger (unused `key` parameter dropped)
//   selfNickname                  -> capabilities.getNickname() (a lazy call at each original position)
//   Math.random()                 -> capabilities.random()
//   internal isDirectedAtAi call  -> legacyIsDirectedAtAi
//
// Regexes, flags, coercion order, repeated reads, truthiness and return labels are untouched.
// This fixture must never import src/core or read task state; it exists only to produce independent
// expectations for scripts/test-wake-trigger.mjs.

export const LEGACY_PROVENANCE = Object.freeze({
  baseline: 'dirty workspace 2026-10-18 (uncommitted wake-policy stage on ca43576)',
  bridgeSha256: 'C14FC28A7EB00F296D1B8B121C18D88DD93898AC21AE9314D2BA4586691D4522',
  file: 'src/bridge.js',
  isDirectedAtAiLines: '11130-11144',
  evaluateWakeTriggerV2Lines: '12255-12290',
});

// Exact body from src/bridge.js:11130-11144 (only the function name changed).
export function legacyIsDirectedAtAi(textContent) {
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

// Exact body from src/bridge.js:12255-12290, with only the mechanical substitutions listed above.
export function legacyEvaluateWakeTrigger(st, event, kind, textContent, plainContent, quoteTargetIsSelf, capabilities) {
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
  if (tr.question && legacyIsDirectedAtAi(plainContent)) return 'question';
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
