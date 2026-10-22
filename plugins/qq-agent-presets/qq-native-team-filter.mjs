// Replace only the native tool-agent-team profile row on DSH 0.2.1.
// Ordinary DSH agents still use the original implementation and configuration.
import z from '@deepseek-ai/schemastery';
import { qqFilteredTeamContext } from './qq-team-tools-context.mjs';
export const name = 'qq-native-team-filter';
export const inject = ['loader', 'agents', 'agentTeams', 'tools', 'systemPrompt', 'sessionProjections'];
export const Config = z.object({
  interrupt: z.boolean().default(true),
  freshProvider: z.string().default('spawn'),
  forkProvider: z.string().default('fork'),
});

export async function apply(ctx, config) {
  // Native packages are archived and are not Node dependencies of this linked
  // plugin. Use Cordis' importer so resolution stays inside the running DSH.
  const namespace = await ctx.loader.import('@deepseek-ai/dsh-experimental-tool-agent-team');
  const native = namespace.default ?? namespace;
  return native.apply(qqFilteredTeamContext(ctx), config);
}
