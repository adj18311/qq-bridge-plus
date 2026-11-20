// Disposable, isolated DSH tool-hook probe (hardened).
// No QQ/platform/formal profile is contacted. Artifacts remain under a fresh temp root
// (may contain an isolated DSH-generated local signing key) and must NOT be cleaned up (§8).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DSH_CLI_REL = path.join('resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function readAsarHeader(asarPath) {
  let fd;
  try {
    fd = fs.openSync(asarPath, 'r');
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const headerSize = head.readUInt32LE(4);
    const jsonLength = headerSize - 8;
    const headerBuf = Buffer.alloc(jsonLength);
    fs.readSync(fd, headerBuf, 0, jsonLength, 16);
    return { fd, base: 8 + headerSize, header: JSON.parse(headerBuf.toString('utf8')) };
  } catch {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
    return null;
  }
}

function readAsarEntry(parsed, relativePath) {
  if (parsed === null) return null;
  let node = parsed.header;
  for (const segment of relativePath.split('/')) {
    node = node?.files?.[segment];
    if (node === undefined) return null;
  }
  if (node.files !== undefined) return null;
  const payload = Buffer.alloc(node.size);
  fs.readSync(parsed.fd, payload, 0, node.size, parsed.base + Number(node.offset));
  return payload;
}

function readAsarRootPackage(asarPath) {
  const parsed = readAsarHeader(asarPath);
  try {
    const payload = readAsarEntry(parsed, 'package.json');
    return payload === null ? null : JSON.parse(payload.toString('utf8'));
  } catch {
    return null;
  } finally {
    if (parsed !== null) try { fs.closeSync(parsed.fd); } catch { /* ignore */ }
  }
}

function asarHasEntry(asarPath, relativePath) {
  const parsed = readAsarHeader(asarPath);
  try {
    return readAsarEntry(parsed, relativePath) !== null;
  } finally {
    if (parsed !== null) try { fs.closeSync(parsed.fd); } catch { /* ignore */ }
  }
}

/** 运行时发现 DSH 安装（不写死）：env 覆盖 + 常见安装根；路径/版本缺失给出清晰错误。 */
function resolveDshInstall(env = process.env) {
  const executable = 'DeepSeek Harness.exe';
  const candidates = [];
  for (const explicit of [env.DSH_DESKTOP_EXE, env.DSH_EXE]) {
    if (typeof explicit === 'string' && explicit.trim() !== '') candidates.push(path.resolve(explicit.trim()));
  }
  candidates.push('D:\\DSH Desktop\\DeepSeek Harness.exe');
  if (env.LOCALAPPDATA) candidates.push(path.join(env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', executable));
  if (env.ProgramFiles) candidates.push(path.join(env.ProgramFiles, 'DeepSeek Harness', executable));
  const exe = candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (exe === undefined) {
    throw Object.assign(new Error(`找不到 DSH Desktop 可执行文件；可用 DSH_DESKTOP_EXE 指定。尝试过：${candidates.join(' | ')}`), { code: 'DSH_NOT_FOUND' });
  }
  const installDir = path.dirname(exe);
  const asar = path.join(installDir, 'resources', 'app.asar');
  const cli = path.join(installDir, DSH_CLI_REL);
  if (!fs.existsSync(asar)) throw Object.assign(new Error(`DSH app.asar 不存在：${asar}`), { code: 'DSH_ASAR_MISSING' });
  const marker = `app.asar${path.sep}`;
  const markerIndex = cli.indexOf(marker);
  const cliRel = (markerIndex >= 0 ? cli.slice(markerIndex + marker.length) : path.relative(installDir, cli)).split(path.sep).join('/');
  if (!asarHasEntry(asar, cliRel)) throw Object.assign(new Error(`DSH CLI 在 app.asar 内不存在：${cliRel}`), { code: 'DSH_CLI_MISSING' });
  const pkg = readAsarRootPackage(asar);
  return { exe, installDir, asar, cli, version: typeof pkg?.version === 'string' ? pkg.version : null, versionSource: pkg === null ? 'unknown' : 'app.asar/package.json' };
}

function parseInventory(dumpText, patchEntries) {
  const plugins = [];
  let pendingId = null;
  for (const line of dumpText.split(/\r?\n/)) {
    const idMatch = line.match(/^\s*-\s*id:\s*(\S+)\s*$/);
    if (idMatch) { pendingId = idMatch[1]; continue; }
    const nameMatch = line.match(/^\s+name:\s*'?([^'\n]+?)'?\s*$/);
    if (nameMatch && pendingId !== null) {
      plugins.push({ id: pendingId, name: nameMatch[1] });
      pendingId = null;
    }
  }
  const uniquePlugins = [...new Map(plugins.map(item => [item.name, item])).values()];
  const patchPlugins = [];
  for (const row of patchEntries) {
    for (const entry of (Array.isArray(row?.insert) ? row.insert : [])) {
      patchPlugins.push({ id: entry.id, name: entry.name, source: 'patch' });
      if (typeof entry?.config?.serverName === 'string') {
        patchPlugins.push({ id: `${entry.id}:mcp`, name: `mcp-server:${entry.config.serverName}`, source: 'patch' });
      }
    }
  }
  const mcpServers = [
    ...uniquePlugins.filter(item => /mcp/i.test(item.name)).map(item => ({ name: item.name, source: 'dump-config' })),
    ...patchPlugins.filter(item => /^mcp-server:/.test(item.name)).map(item => ({ name: item.name.slice('mcp-server:'.length), source: 'patch' })),
  ];
  const modelAdapters = [
    ...uniquePlugins.filter(item => /llm|model|adapter/i.test(item.name)).map(item => ({ name: item.name, source: 'dump-config' })),
    { name: 'isolated-fixture', source: 'fixture', note: 'in-process fake LlmAdapter; no network' },
  ];
  return {
    counts: { plugins: uniquePlugins.length, patchEntries: patchPlugins.length, mcpServers: mcpServers.length, modelAdapters: modelAdapters.length },
    plugins: uniquePlugins,
    patchEntries: patchPlugins,
    mcpServers,
    modelAdapters,
    notFromFormalProfile: [
      'DSH_HOME 指向新建临时目录（未复制正式 profile/state）',
      'profile patrol-probe 由内建 web 模板创建（--from-default-profile web），不是正式 desktop profile',
      'patch.json 注入 fake MCP 与 patrol-hook-probe 插件',
      'FakeAdapter(provider=isolated-fixture) 为进程内假模型端点，无网络',
    ],
  };
}

function classifyStderr(stderr) {
  const categories = { skillFrontmatter: [], modelRefreshTimeout: [], realErrors: [], warnings: [], other: [] };
  const sanitize = (line) => line
    .replace(/token=[A-Za-z0-9._~-]+/gi, 'token=[REDACTED]')
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, '[REDACTED]')
    .slice(0, 240);
  for (const raw of String(stderr ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    const safe = sanitize(line);
    if (/skill|frontmatter/i.test(line) && /warn|error/i.test(line)) categories.skillFrontmatter.push(safe);
    else if (/model|provider/i.test(line) && /refresh|timeout/i.test(line)) categories.modelRefreshTimeout.push(safe);
    else if (/\b(error|fatal|exception|failed|uncaught)\b/i.test(line)) categories.realErrors.push(safe);
    else if (/\bwarn(ing)?\b/i.test(line)) categories.warnings.push(safe);
    else categories.other.push(safe);
  }
  return { bytes: Buffer.byteLength(String(stderr ?? ''), 'utf8'), counts: Object.fromEntries(Object.entries(categories).map(([key, value]) => [key, value.length])), categories };
}

/** 读取 result.json：结构校验 + 尾部截断容错；不因半截 JSON 崩溃。 */
function readEvidence(file) {
  if (!fs.existsSync(file)) return { ok: false, error: 'missing', rawTail: '' };
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return { ok: false, error: `read-${error?.code ?? 'failed'}`, rawTail: '' };
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, error: 'invalid-root', rawTail: raw.slice(-400) };
    if (parsed.version !== 2 || !Array.isArray(parsed.cases)) return { ok: false, error: 'invalid-shape', rawTail: raw.slice(-400) };
    return { ok: true, evidence: parsed };
  } catch (error) {
    return { ok: false, error: `json-${error?.name ?? 'parse'}`, rawTail: raw.slice(-400) };
  }
}

function scenarioBodyCalls(evidence) {
  const parts = {
    cases: (evidence?.cases ?? []).reduce((sum, item) => sum + (Number(item?.bodyCalls) || 0), 0),
    shortCircuit: Number(evidence?.shortCircuit?.bodyCalls) || 0,
    laterDeny: Number(evidence?.laterDeny?.bodyCalls) || 0,
    earlierExecuteVeto: Number(evidence?.earlierExecuteVeto?.bodyCalls) || 0,
    aborted: Number(evidence?.aborted?.bodyCalls) || 0,
    laterExecuteVeto: Number(evidence?.laterExecuteVeto?.bodyCalls) || 0,
    postShortCircuit: Number(evidence?.postShortCircuit?.bodyCalls) || 0,
    modelTurn: Number(evidence?.modelTurn?.bodyCalls) || 0,
    ptc: Number(evidence?.ptc?.bodyCalls) || 0,
    ptcDeny: Number(evidence?.ptc?.deny?.bodyCalls) || 0,
    guiDelta: Number(evidence?.gui?.bodyCallsDelta) || 0,
    realSessions: (evidence?.realSessions?.calls ?? []).reduce((sum, call) => sum + (Number(call?.bodyCalls) || 0), 0),
    identitySessions: (evidence?.identityProbe?.sessions ?? []).reduce((sum, item) => sum + (Number(item?.bodyCalls) || 0), 0),
    identityOwner: Number(evidence?.identityProbe?.owner?.bodyCalls) || 0,
    identityUnknown: Number(evidence?.identityProbe?.unknown?.bodyCalls) || 0,
  };
  const sum = Object.values(parts).reduce((total, value2) => total + value2, 0);
  return { parts, sum };
}

function listDescendants(rootPid) {
  try {
    const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'],
    { encoding: 'utf8', timeout: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const rows = JSON.parse(raw);
    const list = Array.isArray(rows) ? rows : [rows];
    const children = new Map();
    for (const row of list) {
      const parent = Number(row.ParentProcessId);
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(Number(row.ProcessId));
    }
    const descendants = [];
    const queue = [rootPid];
    while (queue.length > 0) {
      const current = queue.shift();
      for (const childPid of (children.get(current) ?? [])) {
        if (!descendants.includes(childPid)) { descendants.push(childPid); queue.push(childPid); }
      }
    }
    return descendants;
  } catch {
    return [];
  }
}

function pidAlive(pid) {
  try {
    const out = execFileSync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return /\b\d+\b/.test(out) && !/INFO:/i.test(out);
  } catch {
    return false;
  }
}

function portReleased(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(600);
    socket.once('connect', () => done(false));
    socket.once('timeout', () => done(true));
    socket.once('error', () => done(true));
  });
}

function writeJsonAtomic(file, value) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
}

function planReport(dsh) {
  return {
    mode: 'plan',
    dsh: { exe: dsh.exe, cli: dsh.cli, asar: dsh.asar, version: dsh.version, versionSource: dsh.versionSource },
    profileTemplate: {
      source: 'builtin:web',
      query: '--from-default-profile web',
      dump: 'tempDir/template.dump.yml + sha256',
      patchEntries: 'tempDir/patch.json (fake MCP + patrol-hook-probe)',
      notFromFormalProfile: true,
    },
    isolation: {
      dshHome: 'fresh temp dir (no formal profile/state copied)',
      endpoints: { fakeMcp: 'http://127.0.0.1:<ephemeral>/', gui: 'http://127.0.0.1:<ephemeral>/', model: 'in-process fake LlmAdapter' },
      limitation: '仅配置层回环（127.0.0.1）；没有 OS 级网络防火墙，不能机械证明零外连，不得宣称已完全隔离。',
    },
    evidence: {
      resultAtomicWrite: true,
      resultStructureValidation: true,
      inventory: 'plugins/patchEntries/mcpServers/modelAdapters',
      stderrCategories: ['skillFrontmatter', 'modelRefreshTimeout', 'realErrors', 'warnings', 'other'],
      stopVerification: 'recorded PID descendants + GUI/fakeMcp port release',
      attribution: 'per-call callId windows (no auth.at(-1))',
      executeFirstProbe: 'deny→MCP 0; allow→MCP 1 + commit/finish 1; ABORTED→abort rollback; earlier/later execute veto; post short-circuit; callId windows',
    },
    limits: [
      '无法机械证明零外部连接（无 OS 防火墙/网络命名空间）',
      'guard authorize/complete 回调未携带 callId，归因用每次调用窗口 + exec.callId 记录',
      'GUI 探针依赖 isolated DSH Web API 行为，版本变化可能需重验',
    ],
  };
}

async function runProbe() {
  const dsh = resolveDshInstall();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-patrol-hook-probe-'));
  const dshHome = path.join(root, 'home');
  const profile = 'patrol-probe';
  const resultFile = path.join(root, 'result.json');
  const guiTrigger = path.join(root, 'gui-trigger');
  const dumpFile = path.join(root, 'template.dump.yml');
  const reportFile = path.join(root, 'report.json');
  const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'COMSPEC'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
  Object.assign(env, { DSH_HOME: dshHome, ELECTRON_RUN_AS_NODE: '1' });

  const fakeMcpRequests = [];
  let fakeCalls = 0;
  const fakeMcp = http.createServer(async (req, res) => {
    fakeMcpRequests.push({ method: req.method, url: req.url, host: req.headers.host ?? null });
    if (req.method === 'GET' && req.url === '/metrics') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ calls: fakeCalls }));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/') { res.writeHead(405); res.end(); return; }
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > 65536) { res.writeHead(413); res.end(); return; } }
    let request;
    try { request = JSON.parse(raw); } catch { res.writeHead(400); res.end(); return; }
    if (request.id === undefined) { res.writeHead(202); res.end(); return; }
    let result;
    if (request.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'isolated-fake', version: '1' } };
    else if (request.method === 'tools/list') result = { tools: [{ name: 'get_home_content', description: 'Offline fake', inputSchema: {
      type: 'object', properties: { identity: { type: 'string' } }, required: ['identity'], additionalProperties: false,
    } }] };
    else if (request.method === 'tools/call' && request.params?.name === 'get_home_content') { fakeCalls++; result = { content: [{ type: 'text', text: 'fake-result' }], isError: false }; }
    else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'unsupported' } })); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  });
  await new Promise(resolve => fakeMcp.listen(0, '127.0.0.1', resolve));
  const fakeMcpUrl = `http://127.0.0.1:${fakeMcp.address().port}/`;

  const boot = spawnSync(dsh.exe, ['--expose-internals', dsh.cli, '--profile', profile, '--from-default-profile', 'web', '--dump-config'], {
    env, encoding: 'utf8', timeout: 45000, maxBuffer: 12_000_000, windowsHide: true,
  });
  if (boot.status !== 0) {
    await new Promise(resolve => fakeMcp.close(resolve));
    throw Object.assign(new Error(`创建隔离 profile 失败：status=${boot.status} error=${boot.error?.code ?? null}`), { code: 'PROFILE_CREATE_FAILED' });
  }
  fs.writeFileSync(dumpFile, boot.stdout, { encoding: 'utf8', mode: 0o600 });
  const templateSha = sha256(boot.stdout);

  const pluginDir = path.join(dshHome, 'profiles', profile, 'node_modules', 'patrol-hook-probe');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.copyFileSync(path.join(project, 'scripts', 'fixtures', 'dsh-isolated-hook-probe.mjs'), path.join(pluginDir, 'index.mjs'));
  fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({ name: 'patrol-hook-probe', version: '0.0.0', private: true, type: 'module', main: 'index.mjs' }));
  const patchEntries = [{ insert: [
    { id: 'fake-xhh-mcp', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'xiaoheihe', transport: 'streamable-http', url: fakeMcpUrl, failOnStartupError: true } },
    { id: 'patrol-hook-probe', name: 'patrol-hook-probe', config: {
      resultFile, fakeMcpUrl, workdir: root, guiTrigger,
      guardUrl: pathToFileURL(path.join(project, 'plugins', 'xhh-quota-guard', 'index.mjs')).href,
      llmUrl: pathToFileURL(path.join(dsh.installDir, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-llm', 'lib', 'index.js')).href,
    } },
  ] }];
  const patchPath = path.join(root, 'patch.json');
  const patchText = JSON.stringify(patchEntries);
  fs.writeFileSync(patchPath, patchText, { encoding: 'utf8', mode: 0o600 });
  const inventory = parseInventory(boot.stdout, patchEntries);

  const child = spawn(dsh.exe, ['--expose-internals', dsh.cli, '--profile', profile, '--patch', patchPath, '--no-open', '--host', '127.0.0.1', '--port', '0'], {
    env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  let launchUrl = null;
  child.stderr.on('data', chunk => { stderr += chunk.toString(); if (stderr.length > 200_000) stderr = stderr.slice(-100_000); });
  let stdout = '';
  child.stdout.on('data', chunk => {
    stdout += chunk.toString();
    const match = stdout.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/);
    if (match) launchUrl = match[0];
    if (stdout.length > 65536) stdout = stdout.slice(-32768);
  });

  const start = Date.now();
  let guiSent = false;
  let guiRpc = { status: 'unverified' };
  let evidenceRead = { ok: false, error: 'missing', rawTail: '' };
  while (child.exitCode === null && child.signalCode === null && Date.now() - start < 30000) {
    evidenceRead = readEvidence(resultFile);
    if (evidenceRead.ok) {
      const snapshot = evidenceRead.evidence;
      if (snapshot.probeError || snapshot.gui?.status === 'complete') break;
      if (!guiSent && snapshot.gui?.status === 'ready' && launchUrl) {
        guiSent = true;
        try {
          const target = new URL(launchUrl);
          if (target.hostname !== '127.0.0.1') throw new Error('non-loopback GUI endpoint');
          const exchange = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(3000) });
          const cookie = exchange.headers.get('set-cookie')?.split(';')[0];
          await exchange.body?.cancel();
          if (!cookie) throw new Error('no isolated browser cookie');
          fs.writeFileSync(guiTrigger, '1');
          const rpcId = randomUUID();
          const request = { sessionId: 'probe-session-a', mode: 'queue', requestId: randomUUID(), content: [{ type: 'text', text: 'isolated GUI API probe' }] };
          const response = await fetch(new URL('/api/session/prompt', target), { method: 'POST', headers: { 'content-type': 'application/json', cookie },
            body: JSON.stringify({ type: 'client-request', rpcId, method: 'session/prompt', payload: { args: { request } } }), signal: AbortSignal.timeout(3000) });
          const body = await response.json();
          guiRpc = { status: response.ok && body?.result?.ok === true ? 'accepted' : 'rejected', httpStatus: response.status };
          if (guiRpc.status !== 'accepted') break;
        } catch (error) { guiRpc = { status: 'unverified', error: error?.name ?? 'Error' }; break; }
      }
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  const guiPort = launchUrl === null ? null : Number(new URL(launchUrl).port);
  const fakeMcpPort = fakeMcp.address().port;
  const descendantsBefore = listDescendants(child.pid);
  const stop = { rootPid: child.pid, descendants: descendantsBefore, method: 'observed', treeSurvivors: [], ports: {} };
  const waitExit = async (ms) => {
    const exited = new Promise(resolve => child.once('exit', resolve));
    return Promise.race([exited, new Promise(resolve => setTimeout(() => resolve(null), ms))]);
  };
  if (child.exitCode === null && child.signalCode === null) {
    child.kill();
    stop.method = 'root PID SIGTERM';
    if ((await waitExit(3000)) === null) {
      try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8', timeout: 8000, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] }); } catch { /* reported via survivors */ }
      stop.method = 'taskkill /PID <recorded-root> /T /F';
      await waitExit(5000);
    }
  }
  stop.processStopped = child.exitCode !== null || child.signalCode !== null;
  await new Promise(resolve => setTimeout(resolve, 300));
  stop.treeSurvivors = descendantsBefore.filter(pid => pidAlive(pid));
  fakeMcp.closeAllConnections();
  await new Promise(resolve => fakeMcp.close(resolve));
  stop.ports.fakeMcp = { port: fakeMcpPort, host: '127.0.0.1', released: await portReleased('127.0.0.1', fakeMcpPort) };
  if (guiPort !== null) stop.ports.gui = { port: guiPort, host: '127.0.0.1', released: await portReleased('127.0.0.1', guiPort) };

  evidenceRead = readEvidence(resultFile);
  const evidence = evidenceRead.ok ? evidenceRead.evidence : null;
  const stderrAnalysis = classifyStderr(stderr);
  const attributionCalls = evidence?.attribution?.calls ?? [];
  const report = {
    version: 2,
    root,
    dsh: { exe: dsh.exe, cli: dsh.cli, asar: dsh.asar, version: dsh.version, versionSource: dsh.versionSource },
    profileTemplate: {
      source: 'builtin:web', query: '--from-default-profile web', profile,
      dumpPath: dumpFile, dumpSha256: templateSha, dumpBytes: Buffer.byteLength(boot.stdout, 'utf8'),
      patchPath, patchSha256: sha256(patchText), notFromFormalProfile: true,
    },
    inventory,
    network: {
      configured: { fakeMcp: fakeMcpUrl, guiHost: '127.0.0.1', model: 'in-process fake adapter' },
      observed: { fakeMcpRequests: fakeMcpRequests.slice(0, 50), fakeMcpRequestCount: fakeMcpRequests.length, guiRpc },
      limitation: '仅配置层回环（127.0.0.1）；没有 OS 级网络防火墙，无法机械证明零外部连接，不得宣称已完全隔离。',
    },
    evidenceRead: {
      ok: evidenceRead.ok,
      error: evidenceRead.ok ? null : evidenceRead.error,
      rawTail: evidenceRead.ok ? null : evidenceRead.rawTail,
      tempLeftovers: fs.readdirSync(root).filter(name => name.startsWith('result.json.') && name.endsWith('.tmp')),
    },
    evidence,
    stderr: stderrAnalysis,
    stop,
    attribution: {
      method: 'per-call windows keyed by callId (fixture) + global arrays retained for compatibility',
      limitation: 'guard authorize/complete 回调不携带 callId；窗口归因为调用级近似，DSH exec.callId 一并记录。',
      calls: attributionCalls,
      callsWithAttribution: attributionCalls.filter(call => Array.isArray(call.authorizeKeys) && call.authorizeKeys.length > 0).length,
    },
    executeFirst: evidence === null ? null : {
      cases: evidence.cases,
      shortCircuit: evidence.shortCircuit,
      laterDeny: evidence.laterDeny,
      earlierExecuteVeto: evidence.earlierExecuteVeto,
      aborted: evidence.aborted,
      laterExecuteVeto: evidence.laterExecuteVeto,
      postShortCircuit: evidence.postShortCircuit,
      guardState: evidence.guardState,
      bodyCalls: scenarioBodyCalls(evidence ?? {}),
      identity: evidence?.identityProbe ?? null,
      backgroundOutputIsolation: evidence?.backgroundOutputIsolation ?? null,
    },
    limitations: [
      '无法机械证明零外部连接（无 OS 防火墙/网络命名空间）',
      'guard 回调未携带 callId，归因使用每调用窗口 + exec.callId；不是端到端强关联',
      'GUI/PTC 依赖真实 isolated DSH 行为，版本变化需重验',
      '临时材料保留在 root 下，未清理（§8 禁止清理）',
      '停止时记录到的子进程列表可能为空（isolated DSH 常为单进程）；taskkill /T 按 root PID 兜底，未做 OS 级全树枚举保证',
      'later execute veto：commit/finish 已发生但 dispatch 被后置 listener 跳过 → 可能“未执行但已计数”（本探针实测 used 保留，known limitation）',
      'post short-circuit：execute-first 的 finish 在 execute 内完成，post 短路只可能跳过兜底/审计；若未来把 finish 移回 post，需要 TTL/对账（B5 未解决）',
      '注册顺序未承诺：earlier execute listener 可跳过本插件；HMR/重复 apply 的监听器去重依赖 DSH fiber，插件未额外做 applied 标记',
    ],
  };
  writeJsonAtomic(reportFile, report);
  try {
    const task59Dir = path.join(os.tmpdir(), 'task59-identity');
    fs.mkdirSync(task59Dir, { recursive: true });
    writeJsonAtomic(path.join(task59Dir, 'report.json'), report);
    fs.writeFileSync(path.join(task59Dir, 'run.log'), `${JSON.stringify({ root, reportFile, fakeCalls, guiRpc, stop, identity: report.executeFirst?.identity, bodyCalls: report.executeFirst?.bodyCalls }, null, 2)}
`, { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    console.error(`[diagnose] 写 task59-identity 证据失败：${error?.message ?? error}`);
  }
  console.log(JSON.stringify({ root, reportFile, pid: stop.rootPid, processStopped: stop.processStopped, fakeMcpCalls: fakeCalls, guiRpc, evidenceRead: report.evidenceRead, stop, stderr: stderrAnalysis.counts, inventory: inventory.counts }, null, 2));

  const cases = evidence?.cases ?? [];
  const modelTurn = evidence?.modelTurn ?? {};
  const gui = evidence?.gui ?? {};
  const ptc = evidence?.ptc ?? {};
  const realCalls = evidence?.realSessions?.calls ?? [];
  const attributedFor = (callId) => attributionCalls.find(call => call.callId === callId) ?? null;
  const guiAttributionKeys = gui?.attribution?.authorizeKeys ?? [];
  const executeFirst = evidence ?? {};
  const bodyCalls = scenarioBodyCalls(executeFirst);
  const guardState = executeFirst.guardState ?? {};
  const good = evidenceRead.ok && report.evidenceRead.tempLeftovers.length === 0 && bodyCalls.sum === fakeCalls && guiRpc.status === 'accepted' && stop.processStopped === true &&
    stop.treeSurvivors.length === 0 && Object.values(stop.ports).every(item => item.released === true) &&
    cases.length === 3 && cases[0].isError === true && cases[0].bodyCalls === 0 &&
    cases[1].isError === false && cases[1].bodyCalls === 1 && cases[2].isError === false && cases[2].bodyCalls === 1 &&
    attributedFor('fixture-deny')?.authorizeKeys?.length === 1 && attributedFor('fixture-allow-a')?.authorizeKeys?.length === 1 &&
    attributedFor('fixture-allow-a')?.commits?.length === 1 && attributedFor('fixture-allow-a')?.completions?.length === 1 &&
    executeFirst.shortCircuit?.authorizeCalls === 1 && executeFirst.shortCircuit?.bodyCalls === 1 &&
    executeFirst.shortCircuit?.commitCalls === 1 && executeFirst.shortCircuit?.completionCalls === 1 &&
    executeFirst.laterDeny?.authorizeCalls === 0 && executeFirst.laterDeny?.bodyCalls === 0 && executeFirst.laterDeny?.completionCalls === 0 &&
    executeFirst.earlierExecuteVeto?.authorizeCalls === 0 && executeFirst.earlierExecuteVeto?.bodyCalls === 0 &&
    executeFirst.aborted?.authorizeCalls === 1 && executeFirst.aborted?.commitCalls === 1 && executeFirst.aborted?.abortCalls === 1 &&
    executeFirst.aborted?.completionCalls === 0 && executeFirst.aborted?.bodyCalls === 0 && executeFirst.aborted?.usedDelta === 0 &&
    executeFirst.laterExecuteVeto?.authorizeCalls === 1 && executeFirst.laterExecuteVeto?.commitCalls === 1 &&
    executeFirst.laterExecuteVeto?.completionCalls === 1 && executeFirst.laterExecuteVeto?.bodyCalls === 0 &&
    executeFirst.laterExecuteVeto?.usedRetained === true &&
    executeFirst.postShortCircuit?.authorizeCalls === 1 && executeFirst.postShortCircuit?.bodyCalls === 1 &&
    executeFirst.postShortCircuit?.completionCalls === 1 &&
    executeFirst.guardState?.reserved === 0 &&
    modelTurn.status === 'complete' && modelTurn.finished === true && modelTurn.outputText === 'done' && modelTurn.followupError === null &&
    modelTurn.bodyCalls === 1 && modelTurn.authorizeCalls === 1 && modelTurn.commitCalls === 1 && modelTurn.completionCalls === 1 &&
    (modelTurn.attribution?.authorizeKeys ?? []).includes('probe-session-a') &&
    ptc.status === 'complete' && ptc.bodyCalls === 1 && ptc.authorizeCalls === 1 && ptc.commitCalls === 1 &&
    (attributedFor('fixture-ptc')?.authorizeKeys ?? []).includes('probe-session-b') &&
    ptc.deny?.isError === true && ptc.deny?.bodyCalls === 0 && (attributedFor('fixture-ptc-deny')?.authorizeKeys ?? []).includes('probe-session-deny') &&
    gui.status === 'complete' && gui.agentId === 'probe-session-a' && gui.bodyCallsDelta === 1 &&
    gui.bodyCallsTotal === fakeCalls && guiAttributionKeys.includes('probe-session-a') &&
    guardState.used === guardState.commits - guardState.aborts && guardState.completes === guardState.used && guardState.reserved >= 0 &&
    executeFirst.identityProbe?.distinct === true && executeFirst.identityProbe?.stable === true &&
    (executeFirst.identityProbe?.sessions ?? []).length === 3 &&
    executeFirst.identityProbe.sessions.every((item) => item.commitCalls === 1 && item.completionCalls === 1 && item.bodyCalls === 1) &&
    executeFirst.identityProbe.owner?.isError === false && executeFirst.identityProbe.owner?.bodyCalls === 1 &&
    executeFirst.identityProbe.owner?.commitCalls === 0 && executeFirst.identityProbe.owner?.completionCalls === 0 &&
    executeFirst.identityProbe.owner?.pluginAgentKey === 'probe-session-owner' &&
    executeFirst.identityProbe.unknown?.isError === true && executeFirst.identityProbe.unknown?.bodyCalls === 0 &&
    executeFirst.identityProbe.unknown?.authorizeCalls === 1 &&
    gui?.attribution?.pluginAgentKey === 'probe-session-a' &&
    executeFirst.backgroundOutputIsolation?.status === 'unverified' &&
    (gui?.attribution?.completions ?? []).length === 1 &&
    evidence?.realSessions?.status === 'complete' && realCalls.length === 4 && (attributedFor('real-3')?.authorizeKeys ?? []).includes('probe-session-deny') &&
    dsh.version !== null && inventory.counts.plugins > 0 && inventory.counts.mcpServers > 0;
  return good ? 0 : 1;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('用法：node scripts/diagnose-dsh-isolated-hooks.mjs [--plan]');
    console.log('  --plan  只输出计划/运行时信息（不启动 DSH）');
    return 0;
  }
  let dsh;
  try {
    dsh = resolveDshInstall();
  } catch (error) {
    console.error(`[diagnose] ${error?.message ?? error}`);
    return 2;
  }
  if (args.includes('--plan')) {
    console.log(JSON.stringify(planReport(dsh), null, 2));
    return 0;
  }
  return runProbe();
}

main().then((code) => { if (typeof code === 'number') process.exitCode = code; }).catch((error) => {
  console.error('[diagnose] unexpected:', error?.stack ?? error);
  process.exitCode = 1;
});
