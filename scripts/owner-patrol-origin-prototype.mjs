// 离线研究样品：不是授权实现；不接生产，不可用于签发权限。
// 返回值仅为策略走向，并不代表实际门禁已签票或平台已执行。
export function decidePrototypePolicy(origin, operation) {
  if (origin === 'owner' && (operation === 'write' || operation === 'credential')) return 'existing';
  if (origin === 'patrol' && operation === 'write') return 'quota';
  return 'deny';
}
export function createOriginPrototype({ sessionId, epoch }) {
  if (typeof sessionId !== 'string' || !sessionId || typeof epoch !== 'string' || !epoch) throw new TypeError('sessionId 与 epoch 必填');
  const registered = new Map();
  const consumed = new Set();
  const turns = new Map();
  const steps = new Set();
  const calls = new Map();
  const lastSteps = new Map();
  const ended = new Set();
  let activeTurn = null;
  let maxTurn = 0;
  let continuityLost = false;
  const stepKey = (turn, step) => `${turn}:${step}`;
  const pos = (value) => Number.isSafeInteger(value) && value > 0;
  return {
    disconnect() { continuityLost = true; },
    end(input) {
      if (input?.sessionId !== sessionId || !pos(input.turn) || input.turn !== activeTurn) return;
      ended.add(input.turn);
      activeTurn = null;
    },
    register(id, origin) {
      if (typeof id !== 'string' || !id || !['owner', 'patrol'].includes(origin) || registered.has(id) || consumed.has(id)) throw new TypeError('登记非法或重复');
      registered.set(id, origin);
    },
    step(input) {
      if (input?.sessionId !== sessionId || !pos(input.turn) || ended.has(input.turn) || !pos(input.step) || !Array.isArray(input.messages)) return;
      if (activeTurn !== input.turn) {
        if (input.turn <= maxTurn) { continuityLost = true; return; }
        if (activeTurn !== null) {
          turns.set(activeTurn, 'unknown');
          continuityLost = true;
        }
        activeTurn = input.turn;
        maxTurn = input.turn;
      }
      const key = stepKey(input.turn, input.step);
      if (steps.has(key)) { turns.set(input.turn, 'unknown'); return; }
      steps.add(key);
      const expected = (lastSteps.get(input.turn) ?? 0) + 1;
      lastSteps.set(input.turn, Math.max(lastSteps.get(input.turn) ?? 0, input.step));
      if (input.step !== expected) { turns.set(input.turn, 'unknown'); return; }
      const prior = turns.get(input.turn);
      const sources = input.messages.map((id) => {
        if (typeof id !== 'string' || !registered.has(id) || consumed.has(id)) return 'unknown';
        const origin = registered.get(id);
        consumed.add(id);
        return origin;
      });
      const unique = new Set(sources);
      const next = continuityLost ? 'unknown' : sources.length === 0 ? prior ?? 'unknown' : unique.size === 1 ? sources[0] : 'unknown';
      turns.set(input.turn, prior === undefined ? next : prior === next ? prior : 'unknown');
    },
    call(input) {
      if (input?.sessionId !== sessionId || typeof input.callId !== 'string' || !input.callId) return;
      if (calls.has(input.callId)) { calls.set(input.callId, null); return; }
      if (!pos(input.turn) || ended.has(input.turn) || !pos(input.step) || !steps.has(stepKey(input.turn, input.step))) { calls.set(input.callId, null); return; }
      calls.set(input.callId, input.turn);
    },
    lookup(input) {
      if (input?.sessionId !== sessionId || typeof input.callId !== 'string') return 'unknown';
      const turn = calls.get(input.callId);
      return continuityLost || turn === undefined || turn === null || ended.has(turn) ? 'unknown' : turns.get(turn) ?? 'unknown';
    },
  };
}
