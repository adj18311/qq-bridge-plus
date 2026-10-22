// Pure reply-timing seam extracted verbatim from src/bridge.js (2026-10-20).
//
// suggestQuietMs / replyTiming are literal transcriptions of the legacy bridge bodies
// suggestQuietMsV2 / replyTimingV2. Config acquisition, the clock and looksLikeUnfinished are
// injected capabilities, read lazily at the original expression sites:
//   getWaitConfig() is cfg.socialV2?.wait (fetched afresh at every original cfg read),
//   now() is Date.now() (called once per eligible message in the burst filter, plus elapsed),
//   looksLikeUnfinished is the pure helper from src/v2-wait.js (passed by identity).
// No module-level I/O, no cached config/time/state/text and no imports.

export function suggestQuietMs(st, capabilities) {
  const defaultMs = Number(capabilities.getWaitConfig()?.defaultQuietMs) || 8000;
  if (!st) return defaultMs;
  const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
  const last = [...recent].reverse().find((m) => m && !m.isSelf);
  if (!last) return defaultMs;
  const text = String(last.tail || last.plain || last.text || '').trim();
  if (capabilities.looksLikeUnfinished(text)) return 12000;
  const burst = recent.filter((m) => m && !m.isSelf && capabilities.now() - Number(m.time || 0) < 15000).length;
  if (burst >= 3) return 12000;
  return defaultMs;
}

export function replyTiming(st, capabilities) {
  const minimum = Number(capabilities.getWaitConfig()?.minQuietAfterNewMs);
  const minQuietMs = Number.isFinite(minimum) ? Math.max(0, minimum) : 10000;
  const maxQuietMs = Math.max(minQuietMs, Math.min(120000, Number(capabilities.getWaitConfig()?.maxMs) || 600000));
  const quietMs = Math.min(maxQuietMs, Math.max(minQuietMs, Math.round(suggestQuietMs(st, capabilities)) || 0));
  const value = Number(st.lastIncomingAt);
  const elapsedMs = Number.isFinite(value) && value > 0 ? Math.max(0, capabilities.now() - value) : 0;
  return { purpose: 'reply', quietMs, remainingQuietMs: Math.max(0, quietMs - elapsedMs) };
}
