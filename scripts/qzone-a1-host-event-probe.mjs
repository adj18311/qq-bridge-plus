// A1 probe v2 — fix two search defects found in v1 and widen the RPC-surface inspection.
//
// v1 problems (worth recording):
//   · the fixture only extracts a FIXED package list, so `dsh-api-session-controller` was not in
//     the temp tree at all — the empty `methods: []` was "package absent", not "no methods"
//   · `dsh-agent` is a thin package; the methods live elsewhere
//   · the append() excerpt printed was a seed-path fragment, not the authorisation site
//
// So v2 reads straight out of the archive by path, and reports "package absent" explicitly rather
// than letting absence masquerade as a negative result.
import fs from 'node:fs';

const ARCHIVE = process.env.DSH_ASAR ?? 'D:/DSH Desktop/resources/app.asar';

function openArchive() {
  const fd = fs.openSync(ARCHIVE, 'r');
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const dataOffset = 8 + head.readUInt32LE(4);
  const jsonSize = head.readUInt32LE(12);
  const buf = Buffer.alloc(jsonSize);
  fs.readSync(fd, buf, 0, jsonSize, 16);
  return { fd, dataOffset, header: JSON.parse(buf.toString('utf8')) };
}

function readFile(handle, relPath) {
  let cur = handle.header;
  for (const seg of relPath.split('/')) {
    cur = cur?.files?.[seg];
    if (!cur) return null;
  }
  // A FILE entry in the asar header has {size, offset} and NO `files`; a DIRECTORY has `files`.
  // The previous version returned null for every real file because it demanded `cur.files`,
  // which made every probe look like a negative finding. That is the same "device defect that
  // silently reports absence" pattern as before.
  if (cur.files || !Number.isSafeInteger(cur.size)) return null;
  const b = Buffer.alloc(cur.size);
  if (cur.size) fs.readSync(handle.fd, b, 0, b.length, handle.dataOffset + Number(cur.offset));
  return b.toString('utf8');
}

function listJs(dirPath, handle, limit = 40) {
  let cur = handle.header;
  for (const seg of dirPath.split('/')) {
    cur = cur?.files?.[seg];
    if (!cur) return null;
  }
  const out = [];
  const walk = (node, prefix, depth) => {
    if (out.length >= limit || depth > 3) return;
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const p = prefix ? `${prefix}/${name}` : name;
      if (child.files) { walk(child, p, depth + 1); continue; }
      if (name.endsWith('.js')) out.push(p);
    }
  };
  walk(cur, dirPath, 0);
  return out;
}

const report = { fixture: { archive: ARCHIVE }, probes: [], limits: [] };
let handle = null;

try {
  handle = openArchive();

  // ── Does the package exist at all? (v1 conflated absence with a negative finding) ──
  const controllerBase = 'dsh/node_modules/@deepseek-ai/dsh-api-session-controller';
  const controllerFiles = listJs(controllerBase, handle);
  report.fixture.sessionControllerPresent = controllerFiles !== null;
  report.fixture.sessionControllerFiles = controllerFiles ?? null;

  if (controllerFiles) {
    const idx = controllerFiles.find((p) => p.endsWith('/lib/index.js'));
    const src = idx ? readFile(handle, idx) : null;
    if (src) {
      const remoteTags = [...src.matchAll(/_(\w+)_decorators\s*=\s*\[\s*Remote(?:\((\{[^}]*\}|"[^"]*")?\))?\s*\]/g)]
        .map((m) => ({ method: m[1], arg: m[2] ?? null }));
      report.probes.push({
        probe: 'RPC surface: which session commands a client may call',
        count: remoteTags.length,
        methods: remoteTags.map((r) => r.method),
        note: 'Every entry is a client-callable command after authenticating. Check whether any of '
          + 'them appends an ARBITRARY event rather than issuing a typed command.',
      });

      // HONEST SCOPE (corrected after review): this classification is by METHOD NAME REGEX only.
      // It is NOT a body-by-body audit. So the maximum it can claim is:
      //   "no RPC method whose NAME matched append|inject|emit|raw"
      // It cannot claim "no RPC path can write an event", and the unclassified list below must be
      // read as "not yet examined", not as "safe".
      //
      // Two of the previously-flagged names were checked BY HAND and are read/subscription paths:
      //   events()        -> returns history frames
      //   observeEvent()  -> subscription stream
      // Those two hand checks are the only body-level evidence in this probe; everything else here
      // is name classification.
      const NAME_WRITE_RE = /append|inject|emit|raw/i;
      const NAME_READ_RE = /observe|events|state|page|list|search|projections|follow|wait|control/i;
      const nameMatchedWrite = remoteTags.filter((r) => NAME_WRITE_RE.test(r.method));
      const nameMatchedRead = remoteTags.filter((r) => NAME_READ_RE.test(r.method));
      const nameUnclassified = remoteTags.filter((r) => !NAME_WRITE_RE.test(r.method) && !NAME_READ_RE.test(r.method));
      report.probes.push({
        probe: 'RPC methods whose NAME looks write-like (name classification only)',
        classification: 'name-regex',
        nameMatchedWrite,
        nameMatchedRead: nameMatchedRead.map((r) => r.method),
        unclassified: nameUnclassified.map((r) => r.method),
        unclassifiedCount: nameUnclassified.length,
        handCheckedBodies: ['events', 'observeEvent'],
        verdict: nameMatchedWrite.length === 0
          ? 'No RPC method NAME matched append|inject|emit|raw. This is a name-level result: it does '
            + 'NOT establish that no RPC path can write an event, and '
            + String(nameUnclassified.length) + ' method(s) remain unexamined.'
          : 'INVESTIGATE: a write-like NAME exists (still only a name-level signal).',
      });
    }
  } else {
    report.probes.push({
      probe: 'session controller package',
      verdict: 'package not present under that path in this archive',
    });
  }

  // ── How does the host APPEND, and does append check anything? ──
  const sessionFiles = listJs('dsh/node_modules/@deepseek-ai/dsh-session', handle);
  if (sessionFiles) {
    const lib = sessionFiles.find((p) => p.endsWith('/lib/index.js'));
    const src = lib ? readFile(handle, lib) : null;
    if (src) {
      const m = /\bappend\s*\(\s*([^)]{0,160})\)\s*\{/.exec(src);
      // HONEST SCOPE: the keyword scan covers a FIXED 900-character window starting at the
      // definition. It shows only that no auth keyword appears near the definition. It says
      // nothing about the rest of the call chain, nor about guards enforced by callers.
      const WINDOW = 900;
      const window = m ? src.slice(m.index, m.index + WINDOW) : null;
      report.probes.push({
        probe: 'dsh-session append() definition',
        found: Boolean(m),
        signature: m ? `append(${m[1].replace(/\s+/g, ' ').trim()})` : null,
        windowScanned: m ? Math.min(WINDOW, src.length - m.index) : 0,
        authKeywordNearDefinition: window === null
          ? null
          : /principal|credential|authori[sz]|token/i.test(window),
        note: 'A false means no auth keyword appears within ' + WINDOW + ' chars of the definition. '
          + 'It does NOT prove the call chain is unauthorised: guards may live in callers, and this '
          + 'scan cannot see them.',
      });
    }
  }

  report.limits.push('No injection into the running production host; archive read only.');
  report.limits.push('RPC classification is NAME-REGEX only; unclassified methods were not examined.');
  report.limits.push('The append() auth check scans a fixed 900-char window near the definition only; '
    + 'it cannot establish the whole call chain is unauthorised.');
  report.limits.push('seq is an internal continuity counter, NOT a source credential. Its presence '
    + 'does not prove an event came through append (a restore path computes seq arithmetically).');
  report.limits.push('Distinguish: (a) legitimately triggering a NEW real turn/tool event via the API, '
    + 'from (b) forging an event into an EXISTING turn. This probe measures neither.');
  report.limits.push('A negative here covers only the entries actually examined; it must not be '
    + 'generalised to all interfaces or all same-account attacks.');
} catch (error) {
  report.error = String(error?.message ?? error);
} finally {
  if (handle) { try { fs.closeSync(handle.fd); } catch {} }
}

console.log(JSON.stringify(report, null, 2));
