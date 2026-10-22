// Native 0.2.1 Team tools are scope-local, so tools.restrict() cannot hide them.
// Filter only the installation observers, leaving the actual Team service intact.
const QQ_PRESETS = new Set(['qq-chat', 'qq-chat-v2']);

export function qqFilteredTeamContext(ctx) {
  const isQqAgent = (agent) => {
    const preset = ctx.sessionProjections?.stateOf?.(agent.session, 'agentPreset')
      ?? agent.session?.header?.agentPreset;
    return QQ_PRESETS.has(preset);
  };
  const agents = new Proxy(ctx.agents, {
    get(target, key) {
      if (key === 'list') return (...args) => target.list(...args).filter((agent) => !isQqAgent(agent));
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return new Proxy(ctx, {
    get(target, key) {
      if (key === 'agents') return agents;
      if (key === 'on') return (event, listener, ...options) => target.on(event,
        event === 'agent/created'
          ? (...args) => { if (!isQqAgent(args[0].agent)) return listener(...args); }
          : listener, ...options);
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
