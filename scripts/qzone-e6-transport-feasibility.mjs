// E6 v6 — clean rewrite after a long series of patch-on-patch edits.
//
// What this probe does, and what it does NOT claim:
//   · extracts dsh/node_modules from the local app.asar into a temp tree (measured: 21045 files /
//     428.3 MB)
//   · imports the REAL WebServer + cordis and starts it with port:0 on 127.0.0.1
//   · VERIFIES the listening socket belongs to our child pid, on loopback, BEFORE any request
//   · only then probes a few paths, and records which phase the child reached
//
// Retracted prior claims (kept here so they are not repeated):
//   · 0xC0000409 does not prove the crash was in teardown, nor that the root cause is a stack overrun
//   · a 404 on three paths does not mean "no /api/* route is registered anywhere"
//   · the bare webserver has no session controller, so nothing follows about real RPC behaviour
//
// Boundaries: child we start, loopback only, temp dirs, no production DSH, no injection, no privilege
// change, no real credentials.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const CHILD = String.raw`
import fs from 'node:fs';
import path from 'node:path';

const out = { phase: 'start', phases: [], steps: [], result: null };
const mark = (p) => { out.phase = p; out.phases.push(p); };

function die(msg, code) {
  try { process.stdout.write(JSON.stringify({ ...out, fatal: String(msg).slice(0, 600), diedAtPhase: out.phase })); } catch {}
  process.exit(code);
}
process.on('uncaughtException', (e) => die('uncaught: ' + (e && e.message), 7));
process.on('unhandledRejection', (e) => die('unhandled: ' + (e && e.message), 8));

const ARCHIVE = process.env.DSH_ASAR;
const destRoot = process.env.E6_DEST;
let fd;
try { fd = fs.openSync(ARCHIVE, 'r'); } catch (e) { die('open asar: ' + String(e && e.message), 3); }

const head = Buffer.alloc(16); fs.readSync(fd, head, 0, 16, 0);
const dataOffset = 8 + head.readUInt32LE(4);
const jsonSize = head.readUInt32LE(12);
const block = Buffer.alloc(jsonSize); fs.readSync(fd, block, 0, jsonSize, 16);
const header = JSON.parse(block.toString('utf8'));

const findEntry = (rel) => {
  let cur = header;
  for (const seg of rel.split('/')) { cur = cur?.files?.[seg]; if (!cur) return null; }
  return cur;
};

let fileCount = 0;
let byteCount = 0;
function extractTree(relRoot, dest) {
  const entry = findEntry(relRoot);
  if (!entry || !entry.files) return false;
  const walk = (node, cur) => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const p = cur + '/' + name;
      if (child.files) { walk(child, p); continue; }
      if (child.link || !Number.isSafeInteger(child.size)) continue;
      let bytes;
      if (child.unpacked) bytes = fs.readFileSync(path.join(ARCHIVE + '.unpacked', ...p.split('/')));
      else { bytes = Buffer.alloc(child.size); if (child.size) fs.readSync(fd, bytes, 0, bytes.length, dataOffset + Number(child.offset)); }
      const target = path.join(dest, ...p.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes);
      fileCount += 1; byteCount += bytes.length;
    }
  };
  walk(entry, relRoot);
  return true;
}

mark('extracting');
const NM = 'dsh/node_modules';
const nmEntry = findEntry(NM);
if (!nmEntry?.files) die('dsh/node_modules missing from archive', 3);

let roots = 0;
const failures = [];
for (const top of Object.keys(nmEntry.files)) {
  if (top.startsWith('@')) {
    for (const child of Object.keys(nmEntry.files[top].files ?? {})) {
      const rel = NM + '/' + top + '/' + child;
      try { if (extractTree(rel, destRoot)) roots += 1; else failures.push(rel); }
      catch (e) { failures.push(rel + ': ' + String(e && e.message).slice(0, 70)); }
    }
    continue;
  }
  const rel = NM + '/' + top;
  try { if (extractTree(rel, destRoot)) roots += 1; else failures.push(rel); }
  catch (e) { failures.push(rel + ': ' + String(e && e.message).slice(0, 70)); }
}
fs.writeFileSync(path.join(destRoot, 'package.json'), JSON.stringify({ name: 'e6f', type: 'module' }), 'utf8');
out.steps.push({ name: 'extracted', roots, files: fileCount, megabytes: Number((byteCount / 1048576).toFixed(1)), failures: failures.slice(0, 5) });
mark('extracted');

let WebServer = null; let cordis = null;
try {
  const wsUrl = 'file:///' + path.join(destRoot, NM, '@deepseek-ai', 'dsh-host-webserver', 'lib', 'index.js').replace(/\\/g, '/');
  const mod = await import(wsUrl);
  WebServer = mod.WebServer ?? mod.default;
  const cUrl = 'file:///' + path.join(destRoot, NM, '@deepseek-ai', 'cordis', 'lib', 'index.js').replace(/\\/g, '/');
  cordis = await import(cUrl);
  out.steps.push({ name: 'imported', webserverIsFunction: typeof WebServer === 'function', cordisHasContext: Boolean(cordis?.Context) });
} catch (e) { die('import: ' + String(e && e.message), 4); }
mark('imported');

let root = null; let svc = null;
try {
  root = new cordis.Context();
  root.plugin(WebServer, { host: '127.0.0.1', port: 0 });
  await new Promise((r) => setTimeout(r, 500));
  svc = root.get('webServer') ?? root.get('webserver') ?? root.get('WebServer');
  out.steps.push({ name: 'service', found: Boolean(svc), listenedPort: svc?.listenedPort ?? null, hasClose: typeof svc?.close === 'function' });
} catch (e) { die('start: ' + String(e && e.message), 5); }
mark('started');

out.result = { listenedPort: svc?.listenedPort ?? null, selfPid: process.pid, host: '127.0.0.1' };

mark('awaitingParent');
process.on('message', async (m) => {
  if (!m || m.type !== 'stop') return;
  mark('disposing');
  const hasClose = typeof svc?.close === 'function';
  if (hasClose) {
    try { await svc.close(); out.steps.push({ name: 'closeOutcome', ok: true }); }
    catch (e) { out.steps.push({ name: 'closeOutcome', ok: false, message: String(e && e.message).slice(0, 200) }); }
  } else {
    out.steps.push({ name: 'closeOutcome', ok: false, reason: 'service has no close()' });
  }
  mark('disposed');
  try { fs.closeSync(fd); } catch {}
  process.stdout.write(JSON.stringify({ ...out, done: true }));
  process.exit(0);
});
process.stdin.resume();
process.stdin.on('end', () => { mark('stdinClosed'); process.exit(0); });
`;

const report = {
  method: 'E6 v6: real webserver in a self-started child, identity verified before probing',
  whatThisDoes: [
    'extracts dsh/node_modules from app.asar into a temp tree',
    'imports the real WebServer + cordis and starts it with port:0 on 127.0.0.1',
    'verifies the listening socket is our child pid on loopback BEFORE any request',
    'probes three paths only, then disposes and records the phases reached',
  ],
  retractedPriorClaims: [
    '0xC0000409 does not prove the crash happened during teardown',
    '0xC0000409 does not prove the root cause is a stack buffer overrun',
    'a 404 on three paths does not generalise to all /api/*',
    'the bare webserver has no session controller, so nothing follows about real RPC',
  ],
  isolationNotVerified: [
    'file system: the child can still read the real profile and the real app.asar',
    'network: nothing prevents the child from opening other sockets',
    'credentials: the child can read whatever this Windows account can read',
  ],
  identity: { verifiedBeforeProbe: false },
  result: null,
  verdict: null,
};

let tmp = null;
let child = null;

try {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qzone-e6v6-'));
  const fakeHome = path.join(tmp, 'home');
  const fakeTemp = path.join(tmp, 'temp');
  const dest = path.join(tmp, 'tree');
  for (const d of [fakeHome, fakeTemp, dest]) fs.mkdirSync(d, { recursive: true });

  const script = path.join(tmp, 'child.mjs');
  fs.writeFileSync(script, CHILD, 'utf8');

  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    windir: process.env.windir,
    NUMBER_OF_PROCESSORS: process.env.NUMBER_OF_PROCESSORS,
    USERPROFILE: fakeHome,
    TEMP: fakeTemp,
    TMP: fakeTemp,
    E6_DEST: dest,
    DSH_ASAR: 'D:/DSH Desktop/resources/app.asar',
  };

  child = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'], env });
  let stdoutBuf = '';
  let stderrBuf = '';
  child.stderr.on('data', (b) => { stderrBuf += String(b); });

  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child not ready within 600s')), 600_000);
    child.stdout.on('data', (b) => {
      stdoutBuf += String(b);
      for (const line of stdoutBuf.split('\n')) {
        if (!line.trim().startsWith('{')) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.done) continue;
          if (msg.fatal) { clearTimeout(timer); reject(new Error(msg.fatal + ' (phase ' + msg.diedAtPhase + ')')); return; }
          if (msg.result) { clearTimeout(timer); resolve(msg); return; }
        } catch { /* partial line */ }
      }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error('child exited ' + code + ' before ready; stderr=' + stderrBuf.slice(-400))); });
  });

  report.result = ready;
  const port = ready.result.listenedPort;
  const childPid = ready.result.selfPid;

  // ── IDENTITY GATE: prove the listener is ours before sending anything ────────────
  let ownerPid = null;
  let ownerAddr = null;
  try {
    const { execFileSync } = await import('node:child_process');
    const lines = execFileSync('netstat', ['-ano'], { encoding: 'utf8', timeout: 20_000 }).split('\n');
    const hit = lines.find((l) => l.includes(':' + port + ' ') && /LISTENING/i.test(l));
    if (hit) {
      const parts = hit.trim().split(/\s+/);
      ownerAddr = parts[1];
      ownerPid = Number(parts[parts.length - 1]);
    }
  } catch (e) {
    report.identity.netstatError = String(e && e.message).slice(0, 160);
  }

  const addrLoopback = typeof ownerAddr === 'string' && /^127\.|^\[::1\]/i.test(ownerAddr);
  const pidMatches = ownerPid === childPid;
  report.identity.socket = { port, ownerPid, ownerAddr, childPid, pidMatches, addrLoopback };
  report.identity.verifiedBeforeProbe = pidMatches && addrLoopback;

  if (!report.identity.verifiedBeforeProbe) {
    report.verdict = 'REFUSED TO PROBE: listening socket could not be proven to be our child on '
      + 'loopback (pidMatch=' + pidMatches + ', loopback=' + addrLoopback + ')';
    report.exitCode = 15;
  } else {
    const base = 'http://127.0.0.1:' + port;
    const probes = [];
    for (const [label, p, init] of [
      ['GET /', '/', { method: 'GET' }],
      ['POST /api/session/prompt', '/api/session/prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }],
      ['POST /api/session/event', '/api/session/event', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }],
    ]) {
      try {
        const res = await fetch(base + p, init);
        probes.push({ label, status: res.status });
      } catch (e) {
        probes.push({ label, error: String(e && e.message).slice(0, 120) });
      }
    }
    report.result.probes = probes;
    report.result.probeScope = 'these 3 paths only';

    child.send({ type: 'stop' });
    const finalMsg = await new Promise((resolve) => {
      let fbuf = '';
      const t = setTimeout(() => resolve(null), 30_000);
      child.stdout.on('data', (b) => {
        fbuf += String(b);
        for (const line of fbuf.split('\n')) {
          if (!line.trim().startsWith('{')) continue;
          try { const m = JSON.parse(line); if (m.done) { clearTimeout(t); resolve(m); return; } } catch { /* partial */ }
        }
      });
      child.on('exit', () => { clearTimeout(t); resolve(null); });
    });

    const exitCode = await new Promise((resolve) => {
      if (child.exitCode !== null) resolve(child.exitCode);
      else { child.on('exit', (c) => resolve(c)); setTimeout(() => resolve('timeout'), 15_000); }
    });

    report.result.dispose = finalMsg ? { reachedPhases: finalMsg.phases, steps: finalMsg.steps } : null;
    report.result.exitCode = exitCode;

    const clean = exitCode === 0;
    report.verdict = clean
      ? 'PASS (narrow scope): identity verified, bare webserver answered on loopback, clean exit'
      : 'PARTIAL: identity verified and the server answered, but exit code ' + exitCode
        + ' (non-zero does not by itself indicate the phase or the cause)';
    report.exitCode = clean ? 0 : 14;
  }
} catch (error) {
  report.error = String(error?.message ?? error);
  if (report.error.includes('(phase ')) report.diedAtPhase = report.error.replace(/.*\(phase ([^)]+)\).*/, '$1');
  report.verdict = 'BLOCKED or FAILED — see error';
  report.exitCode = 13;
  try { child?.kill(); } catch {}
} finally {
  if (tmp) {
    for (let i = 0; i < 10; i += 1) {
      try { fs.rmSync(tmp, { recursive: true, force: true }); break; } catch { /* windows delay */ }
    }
  }
}

console.log(JSON.stringify(report, null, 2));
process.exit(report.exitCode ?? 0);
