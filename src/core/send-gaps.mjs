// Pure message-gap seam extracted verbatim from src/bridge.js (2026-10-20).
//
// clampMessageGap / computeMessageGaps are literal transcriptions of the legacy bridge closure
// bodies clampGapV2 / computeGapsV2 (baseline HEAD f74eb90 as frozen in
// .agent-teams/pure-policy-wave-20261020/bridge.start.js lines 9202-9236). Only the helper name and
// the two capability boundaries changed:
//   - Math.random()  -> capabilities.random()
//   - randInt(...)   -> capabilities.randInt(...)
// The bridge keeps the real randInt helper (swap min>max, then Math.floor(min + Math.random() *
// (max - min + 1))) and passes lazy closures in; nothing is sampled or cached early here.
//
// No module-level I/O, no config reads outside the original expression sites, no defaults for
// capabilities or sendCfg. Config is re-read at every original expression site, and random/randInt
// are consumed only where the frozen body consumed them (fixed/byLength and zero-probability auto
// draw no randomness). Every coercion, short-circuit, loop bound, UTF-16 length, Math.round,
// min-100 clamp and 300/1000/10000 fallback is preserved.
export function clampMessageGap(ms, sendCfg) {
  const min = Math.max(100, Number(sendCfg.burstIntervalMinMs) || 300);
  const max = Math.max(min, Number(sendCfg.maxGapMs) || 10000);
  return Math.max(min, Math.min(max, Math.round(Number(ms) || min)));
}

export function computeMessageGaps(messages, gapMode, gapMs, gaps, sendCfg, capabilities) {
  const delays = [];
  if (!messages || messages.length <= 1) return delays;
  const mode = gapMode === 'fixed' || gapMode === 'byLength' ? gapMode : 'auto';
  if (mode === 'fixed') {
    if (Array.isArray(gaps) && gaps.length >= messages.length - 1) {
      for (let i = 0; i < messages.length - 1; i++) delays.push(clampMessageGap(gaps[i], sendCfg));
    } else {
      const g = clampMessageGap(Number(gapMs) || Number(sendCfg.burstIntervalMinMs) || 1000, sendCfg);
      for (let i = 0; i < messages.length - 1; i++) delays.push(g);
    }
  } else if (mode === 'byLength') {
    const base = Number(sendCfg.gapBaseMs) || 800;
    const perChar = Number(sendCfg.gapPerCharMs) || 20;
    for (let i = 0; i < messages.length - 1; i++) {
      const chars = Math.max(1, String(messages[i] || '').length);
      delays.push(clampMessageGap(base + chars * perChar, sendCfg));
    }
  } else {
    const longProb = Math.min(1, Math.max(0, Number(sendCfg.longGapProbability) || 0));
    for (let i = 0; i < messages.length - 1; i++) {
      const useLong = longProb > 0 && capabilities.random() < longProb;
      const min = useLong ? (Number(sendCfg.longGapMinMs) || 5000) : (Number(sendCfg.burstIntervalMinMs) || 1000);
      const max = useLong ? (Number(sendCfg.longGapMaxMs) || 10000) : (Number(sendCfg.burstIntervalMaxMs) || 3000);
      delays.push(clampMessageGap(capabilities.randInt(Math.max(100, min), Math.max(100, max)), sendCfg));
    }
  }
  return delays;
}
