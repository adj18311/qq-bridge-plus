// RELABEL the probe honestly: this is a STATIC SOURCE WINDOW SCAN, not a dynamic test.
//
// What it actually does: extracts `dsh-session/lib/index.js` text from the app.asar, regex-searches
// a fixed window around the `append(` definition. It never imports the package, never instantiates
// a session, never calls append, never emits a forged tool/call, never runs a prompt, never observes
// an event being recorded.
//
// Therefore the only things it may claim:
//   · a child process was started and it read N bytes of the real file
//   · within the scanned window, no caller-identity keyword appears
//   · within the scanned window, no turn-context / type-allowlist check appears
// It may NOT claim: reachability, "any in-process code can plant an event", that a legitimate path
// was observed, or that isolation of a HOST was demonstrated.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const report = {
  method: 'STATIC SOURCE WINDOW SCAN (not a dynamic test)',
  replaces: 'E4 v1 (circular: measured a self-authored HTTP fixture) — also invalid',
  whatThisDoesNotDo: [
    'does not import dsh-session',
    'does not instantiate a session or an agent',
    'does not call append()',
    'does not emit a forged tool/call',
    'does not run a legitimate prompt',
    'does not observe any event being recorded',
  ],
  isolation: { childStarted: false, details: [] },
  staticFindings: null,
  claimsWithheld: [
    'reachability of append() from any code',
    'that any in-process code can plant an event',
    'that a legitimate prompt path was exercised',
    'that host isolation was demonstrated',
  ],
};

let tmpRoot = null;
try {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qzone-e4-static-'));

  const script = path.join(tmpRoot, 'static-scan.mjs');
  fs.writeFileSync(script, `
import fs from 'node:fs';

const ARCHIVE = 'D:/DSH Desktop/resources/app.asar';
const fd = fs.openSync(ARCHIVE, 'r');
const head = Buffer.alloc(16); fs.readSync(fd, head, 0, 16, 0);
const dataOffset = 8 + head.readUInt32LE(4);
const jsonSize = head.readUInt32LE(12);
const block = Buffer.alloc(jsonSize); fs.readSync(fd, block, 0, jsonSize, 16);
const header = JSON.parse(block.toString('utf8'));
const read = (rel) => { let c = header; for (const s of rel.split('/')) { c = c?.files?.[s]; if (!c) return null; } if (!c || c.files || !Number.isSafeInteger(c.size)) return null; const b = Buffer.alloc(c.size); fs.readSync(fd, b, 0, b.length, dataOffset + Number(c.offset)); return b.toString('utf8'); };

const src = read('dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js');
fs.closeSync(fd);
if (!src) { process.stdout.write(JSON.stringify({ error: 'not readable' })); process.exit(0); }

const def = /\\bappend\\s*\\(\\s*([^)]{0,160})\\)\\s*\\{/.exec(src);
const WIN = 2000;
const window = def ? src.slice(def.index, def.index + WIN) : '';

process.stdout.write(JSON.stringify({
  bytesRead: src.length,
  appendSignature: def ? ('append(' + def[1].replace(/\\s+/g, ' ').trim() + ')') : null,
  windowChars: window.length,
  callerIdentityKeywordInWindow: /principal|credential|authori[sz]|token/i.test(window),
  turnContextKeywordInWindow: /openStep|openTurn|step\\/end|turn\\/end|must be inside/i.test(window),
  typeAllowlistKeywordInWindow: /known-event-types|assertNever|allow ?list|validTypes/i.test(window),
  marker: process.env.E4_MARKER,
  pid: process.pid,
}));
`, 'utf8');

  const marker = `e4static-${process.pid}-${Date.now()}`;
  const run = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, E4_MARKER: marker },
  });
  if (run.error) throw run.error;
  const out = JSON.parse(String(run.stdout || '{}'));

  report.isolation.childStarted = (
    out.error === undefined
    && out.marker === marker
    && Number.isSafeInteger(out.pid)
    && out.pid !== process.pid
    && Number.isSafeInteger(out.bytesRead)
    && out.bytesRead > 1000
  );
  report.isolation.details = [
    `child pid ${out.pid} vs parent ${process.pid}`,
    `marker echoed: ${out.marker === marker}`,
    `real bytes read from archive: ${out.bytesRead}`,
    'this proves a child ran and read a file — nothing about a host being instantiated',
  ];

  report.staticFindings = {
    appendSignature: out.appendSignature,
    windowChars: out.windowChars,
    callerIdentityKeywordInWindow: out.callerIdentityKeywordInWindow,
    turnContextKeywordInWindow: out.turnContextKeywordInWindow,
    typeAllowlistKeywordInWindow: out.typeAllowlistKeywordInWindow,
    interpretation:
      'These are TEXT-SEARCH results over one window of one file. Absence of a keyword does not '
      + 'prove absence of the check (it may live in a caller, a decorator, or outside the window). '
      + 'Presence of a turn-context check would be evidence of a structural guard, but its absence '
      + 'here is not evidence of its absence.',
  };
} catch (error) {
  report.error = String(error?.message ?? error);
} finally {
  if (tmpRoot) {
    for (let i = 0; i < 10; i += 1) {
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* windows delay */ }
    }
  }
}

console.log(JSON.stringify(report, null, 2));
