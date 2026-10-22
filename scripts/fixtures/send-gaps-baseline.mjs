// Frozen legacy oracle for scripts/test-send-gaps.mjs. Test-only; not production code.
//
// Provenance: committed baseline HEAD f74eb90 (src/bridge.js, 2026-10-20), captured before this
// seam was extracted; the immutable pre-edit copy is .agent-teams/pure-policy-wave-20261020/
// bridge.start.js (1-based lines 9202-9236). Both function bodies below are transcriptions of the
// bridge closure functions clampGapV2 / computeGapsV2 (legacy helper names kept verbatim); the only
// textual changes are two spaces of closure indentation removed and the capability factory added.
// Every expression, config read, coercion, short-circuit, loop bound, rounding and fallback
// (min 100 / 300 / 1000 / 10000, defaults 300/1000/800/20/5000/10000/3000, UTF-16 .length,
// messages[i] || '') is identical to the pre-extraction source.
//
// Mechanical injection mapping (the seam boundary, nothing else was rewritten):
//   - `Math.random()`     -> `random()`                where random() delegates to
//                                                        capabilities.random() (its production
//                                                        equivalent is Math.random()).
//   - `randInt(min, max)` -> `randInt(min, max)`        call text is unchanged; the factory's
//                                                        randInt wrapper delegates to
//                                                        capabilities.randInt. The real helper stays
//                                                        in src/bridge.js: if min > max swap them,
//                                                        then Math.floor(min + Math.random() *
//                                                        (max - min + 1)).
// The wrappers read the capability properties lazily on every call and no defaults are supplied,
// mirroring the production contract (missing capabilities only fail when actually sampled).
//
// This is a frozen historical differential fixture: it never imports src/core/send-gaps.mjs and no
// test expectation is derived from that module. Tests always inject deterministic counters.
// Differential contract: identical arguments + identical injected random/randInt sequence +
// identical config getter graph => identical delay arrays, config read order, cap-call order and
// identical errors.

export function createLegacySendGaps(capabilities) {
  const random = () => capabilities.random();
  const randInt = (min, max) => capabilities.randInt(min, max);

  function clampGapV2(ms, sendCfg) {
    const min = Math.max(100, Number(sendCfg.burstIntervalMinMs) || 300);
    const max = Math.max(min, Number(sendCfg.maxGapMs) || 10000);
    return Math.max(min, Math.min(max, Math.round(Number(ms) || min)));
  }

  function computeGapsV2(messages, gapMode, gapMs, gaps, sendCfg) {
    const delays = [];
    if (!messages || messages.length <= 1) return delays;
    const mode = gapMode === 'fixed' || gapMode === 'byLength' ? gapMode : 'auto';
    if (mode === 'fixed') {
      if (Array.isArray(gaps) && gaps.length >= messages.length - 1) {
        for (let i = 0; i < messages.length - 1; i++) delays.push(clampGapV2(gaps[i], sendCfg));
      } else {
        const g = clampGapV2(Number(gapMs) || Number(sendCfg.burstIntervalMinMs) || 1000, sendCfg);
        for (let i = 0; i < messages.length - 1; i++) delays.push(g);
      }
    } else if (mode === 'byLength') {
      const base = Number(sendCfg.gapBaseMs) || 800;
      const perChar = Number(sendCfg.gapPerCharMs) || 20;
      for (let i = 0; i < messages.length - 1; i++) {
        const chars = Math.max(1, String(messages[i] || '').length);
        delays.push(clampGapV2(base + chars * perChar, sendCfg));
      }
    } else {
      const longProb = Math.min(1, Math.max(0, Number(sendCfg.longGapProbability) || 0));
      for (let i = 0; i < messages.length - 1; i++) {
        const useLong = longProb > 0 && random() < longProb;
        const min = useLong ? (Number(sendCfg.longGapMinMs) || 5000) : (Number(sendCfg.burstIntervalMinMs) || 1000);
        const max = useLong ? (Number(sendCfg.longGapMaxMs) || 10000) : (Number(sendCfg.burstIntervalMaxMs) || 3000);
        delays.push(clampGapV2(randInt(Math.max(100, min), Math.max(100, max)), sendCfg));
      }
    }
    return delays;
  }

  return { clampGapV2, computeGapsV2 };
}
