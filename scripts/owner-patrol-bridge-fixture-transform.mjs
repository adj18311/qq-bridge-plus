// Offline VM-only fixture transformation; this never writes src/bridge.js.
export function transformOfflineOwnerPatrolBridge(source) {
  const anchor = '  bot.onPrivateMessage(async (event) => {';
  const incoming = "  async function handleIncoming(kind, id, event, cfg) {\n    const key = convKey(kind, id);";
  const frame = '          const frame = envelope.payload;';
  const sendAnchor = '          // 先做发送频率检查并预占额度，再解析引用目标，避免未限流的引用查询打爆 OneBot。';
  source = source.replace(/\r\n/g, '\n');
  for (const text of [anchor, incoming, frame, sendAnchor]) if (source.split(text).length !== 2) throw new Error('fixture bridge anchor missing or ambiguous');
  source = source.replace(incoming, `${incoming}\n    if (kind === 'private' && String(id) === String(cfg.ownerQQ) && String(event.user_id) === String(cfg.ownerQQ)) {\n      globalThis.__offlineOwnerPatrol.boundary.ownerReceived({ sessionId: state.sessions[key] });\n      globalThis.__offlineOwnerPatrol.sendGate?.ownerArrived({ sessionId: state.sessions[key] });\n    }`);
  source = source.replace(frame, `${frame}\n          if (frame.sessionId === globalThis.__offlineOwnerPatrol.sessionId) {\n            if (frame.type === 'session/event') {\n              globalThis.__offlineOwnerPatrol.stream?.live(frame.event);\n              if (frame.event?.type === 'turn/start') globalThis.__offlineOwnerPatrol.sendGate?.observeTurnStart({ sessionId: frame.sessionId, turn: frame.event.data?.turn });\n            } else if (frame.type === 'session/follow-ended') {\n              globalThis.__offlineOwnerPatrol.stream?.end();\n              globalThis.__offlineOwnerPatrol.sendGate?.interrupt({ sessionId: frame.sessionId });\n            }\n          }`);
  source = source.replace(sendAnchor, `          const offlineClaim = globalThis.__offlineOwnerPatrol.sendGate?.claimSend({ sessionId: state.sessions[key], turn: v2TurnNoV2.get(state.sessions[key]) });\n          if (offlineClaim && offlineClaim.kind !== 'not-patrol' && !offlineClaim.allow) { sendJson({ ok: false, error: 'offline-patrol-owner-pending' }, 409); return; }\n${sendAnchor}`);
  return source.replace(anchor, `  globalThis.__offlineOwnerPatrol.receive = handleIncoming;\n${anchor}`);
}
