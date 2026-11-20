// Bind before connecting. The emitter must be the actual SnowLuma client;
// connecting after an already emitted open remains safely unavailable.
export function bindQzoneConnectionEpoch(bot) {
  if (!bot || typeof bot.on !== 'function' ||
      (typeof bot.off !== 'function' && typeof bot.removeListener !== 'function')) {
    throw new TypeError('invalid connection event source');
  }
  let epoch = 0;
  let connected = false;
  let closed = false;
  const open = () => {
    if (closed) return;
    if (epoch >= Number.MAX_SAFE_INTEGER) { connected = false; closed = true; return; }
    epoch++;
    connected = true;
  };
  const disconnect = () => { connected = false; };
  bot.on('open', open);
  bot.on('close', disconnect);
  bot.on('error', disconnect);
  const remove = typeof bot.off === 'function' ? bot.off.bind(bot) : bot.removeListener.bind(bot);
  return Object.freeze({
    current: () => !closed && connected ? epoch : -1,
    close() {
      closed = true;
      connected = false;
      remove('open', open);
      remove('close', disconnect);
      remove('error', disconnect);
    }
  });
}
