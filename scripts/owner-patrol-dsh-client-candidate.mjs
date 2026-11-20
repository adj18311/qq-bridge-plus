// Offline-only in-memory candidate. This is not imported by production.
import { readFile } from 'node:fs/promises';
export async function loadOfflineDshClient() {
  let source = await readFile(new URL('../src/dsh-client.js', import.meta.url), 'utf8');
  source = source.replace(/\r\n/g, '\n');
  source = source.replace("from 'js-yaml'", `from '${import.meta.resolve('js-yaml')}'`)
    .replace("from '@deepseek-ai/dsh-host-apiproxy/client'", `from '${import.meta.resolve('@deepseek-ai/dsh-host-apiproxy/client')}'`)
    .replace("from './dsh-desktop.js'", `from '${new URL('../src/dsh-desktop.js', import.meta.url).href}'`);
  const anchor = "} else if (sessionId) {\n          sessionToStream.delete(sessionId);\n          streamToSession.delete(msg.streamId);\n          followed.delete(sessionId);\n          // DSH 正常";
  if (source.split(anchor).length !== 2) throw new Error('offline follow-end anchor changed');
  source = source.replace(anchor, `} else if (sessionId) {\n          enqueue({ kind: 'frame', envelope: { rpcId: msg.streamId, payload: { type: 'session/follow-ended', sessionId } } });\n          sessionToStream.delete(sessionId);\n          streamToSession.delete(msg.streamId);\n          followed.delete(sessionId);\n          // DSH 正常`);
  const errorAnchor = "} else if (sessionId) {\n          sessionToStream.delete(sessionId);\n          streamToSession.delete(msg.streamId);\n          followed.delete(sessionId);\n          // 只有已不存在";
  if (source.split(errorAnchor).length !== 2) throw new Error('offline follow-error anchor changed');
  source = source.replace(errorAnchor, `} else if (sessionId) {\n          enqueue({ kind: 'frame', envelope: { rpcId: msg.streamId, payload: { type: 'session/follow-ended', sessionId } } });\n          sessionToStream.delete(sessionId);\n          streamToSession.delete(msg.streamId);\n          followed.delete(sessionId);\n          // 只有已不存在`);
  const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  return module.NodeApiClient;
}
