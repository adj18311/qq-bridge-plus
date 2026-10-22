// Frozen legacy wake-policy oracle for scripts/test-wake-policy.mjs. Test-only; not production code.
//
// Provenance: hand-transcribed MINIMAL legacy expressions from the committed HEAD ca43576
// (src/bridge.js), captured before the wake-policy extraction:
//   - normalizeSpeakerIdsV2: lines 9649-9663;
//   - defaultWakeConfigV2: lines 9665-9697;
//   - EXPLICIT_END_RE: line 9732;
//   - hasExplicitEndV2: lines 9734-9739;
//   - isSleepingConfigV2: lines 9741-9745;
//   - preSleepWaitBlockedV2: lines 9747-9761;
//   - computeWakeSafetyV2: lines 9763-9774;
//   - WAKE_PRIORITY / wakePriorityV2: lines 12694-12711.
// refreshDefaultWakeConfigV2 / refreshAllDefaultWakeConfigsV2 / ensureWakeableV2 are NOT transcribed:
// they stay bridge concerns and are covered by scripts/test-wake-policy-integration.mjs.
//
// This is a frozen historical differential fixture: expected output is never taken from
// src/core/wake-policy.mjs, and this file is not read at runtime (no .agent-teams state access).
// Clock and random are injected callables so call counts/order and returned values stay observable.
// Keep expressions aligned with HEAD; do not "improve" policy while transcribing.

export const LEGACY_PROVENANCE = Object.freeze({
  kind: 'test-only frozen historical reference',
  commit: 'ca43576',
  file: 'src/bridge.js',
  normalizeSpeakerIdsLines: '9649-9663',
  defaultWakeConfigLines: '9665-9697',
  explicitEndLines: '9732-9745',
  preSleepLines: '9747-9761',
  safetyLines: '9763-9774',
  priorityLines: '12694-12711',
  note: 'Independent hand transcription; not imported from the production implementation.',
});

export const LEGACY_EXPLICIT_END_RE =
  /(?:不聊了|不说了|晚安|睡了|先睡了|下了|先下了|拜拜|再见|走了|先走|撤了|去忙|忙了|下次再聊|下次聊|散了吧|结束|就到这|先这样|就这样吧|886|88|睡觉了|下班了|去洗澡|去吃饭了)/i;

export const LEGACY_WAKE_PRIORITY = Object.freeze({
  private: 100,
  atMention: 90,
  question: 80,
  speaker: 75,
  nameMention: 70,
  keyword: 60,
  anyMessage: 50,
  replyCheck: 40,
  timeout: 30,
  proactiveCheck: 20,
});

export const legacyNormalizeSpeakerIds = Object.freeze(function legacyNormalizeSpeakerIds(value) {
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
});

export const legacyDefaultWakeConfig = Object.freeze(function legacyDefaultWakeConfig(w, { now, random }) {
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
      probability: Math.min(1, Math.max(0, Number(w.recommendedProbability) || 0)),
    },
    batchWindowMs: Math.max(1000, Number(w.batchWindowMs) || 8000),
    lastWakeAt: 0,
    wakeCount: 0,
    noActionCount: 0,
    confirmedAt: 0,
    confirmedBy: 'default',
  };
});

export const legacyHasExplicitEnd = Object.freeze(function legacyHasExplicitEnd(st) {
  const recent = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
  const last = [...recent].reverse().find((m) => m && !m.isSelf);
  if (!last) return false;
  return LEGACY_EXPLICIT_END_RE.test(String(last.tail || last.plain || last.text || ''));
});

export const legacyIsSleepingConfig = Object.freeze(function legacyIsSleepingConfig(wc) {
  if (!wc) return false;
  if (wc.mode === 'active' || wc.triggers?.anyMessage) return false;
  return true;
});

export const legacyPreSleepWaitBlocked = Object.freeze(function legacyPreSleepWaitBlocked(st, w, { now }) {
  if (!st) return false;
  if (w.preSleepWaitEnabled === false) return false;
  if (legacyHasExplicitEnd(st)) return false;
  const waitMs = Math.max(0, Number(w.preSleepWaitMs) || 300000);
  const at = now();
  if ((st.lastIncomingAt || 0) && at - st.lastIncomingAt >= waitMs) return false;
  if (st.preSleepWaitSatisfiedAt && (!st.lastIncomingAt || st.lastIncomingAt <= st.preSleepWaitSatisfiedAt)) return false;
  if (st.preSleepWaitObservedAt && (!st.lastIncomingAt || st.lastIncomingAt <= st.preSleepWaitObservedAt)) return false;
  return true;
});

export const legacyComputeWakeSafety = Object.freeze(function legacyComputeWakeSafety(wc, { now }) {
  const tr = wc?.triggers || {};
  const hard = wc?.mode === 'active' || tr.anyMessage || tr.atMention || tr.nameMention || tr.question || tr.poke ||
    (Array.isArray(tr.keywords) && tr.keywords.length > 0) ||
    legacyNormalizeSpeakerIds(tr.speakerIds).length > 0;
  const timed = !wc?.infinite && wc?.sleepUntil && Date.parse(wc.sleepUntil) > now();
  const soft = Number(tr.probability) > 0;
  const guaranteed = hard || timed || soft;
  const confirmedNum = Number(wc?.confirmedAt);
  const stale = !wc?.confirmedAt || !Number.isFinite(confirmedNum) || now() - confirmedNum > 24 * 60 * 60 * 1000;
  return { hard, timed, soft, guaranteed, stale };
});

// The priority table is bridge-owned and passed in by the caller (frozen interface:
// wakePriority(reason, priorities)). The fixture owns this table only as independent test data, so
// the differential test passes the same table object to both sides.
export const legacyWakePriority = Object.freeze(function legacyWakePriority(reason, table) {
  const base = String(reason ?? '').split(':')[0];
  return table[base] ?? 0;
});
