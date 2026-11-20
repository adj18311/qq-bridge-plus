// B3 probe: does a CUSTOM metadata field travel through the real DSH prompt path, and is it
// visible to the model / transcript?
//
// Only `source.rpcId` round-tripping has been demonstrated (test-qzone-real-host-offline-chain.mjs:90).
// This probe reads the AUTHORITATIVE type declarations extracted from the local app.asar and
// reports what the host contract actually allows. It deliberately distinguishes:
//
//   · what the type declares   (static contract — what this probe measures)
//   · what the runtime does    (NOT measured here; Q2/Q3/Q4 stay `established: false`)
//
// A closed union in a .d.ts does NOT prove the runtime rejects extra fields, and the absence of
// an extension slot does NOT prove the model cannot see metadata. Those claims need their own
// experiments.
//
// Precision notes (added after Codex caught a defect in the first version):
//   · the interface body is extracted by BRACE MATCHING, not a fixed-size window, so trailing
//     keys from neighbouring declarations cannot leak into the key list
//   · if `MessageSourceMap` is missing or unparseable the result is `unknown`, never `true`
//   · any index signature is detected by regex on the EXTRACTED BODY, whatever its parameter name
//
// Run: node scripts/qzone-b3-metadata-channel-probe.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WORKSPACE = new URL('../', import.meta.url);

/** Extract `interface Name { ... }` body by brace matching. Returns null when not found. */
function extractInterfaceBody(text, name) {
  const idx = text.indexOf(`interface ${name}`);
  if (idx < 0) return null;
  const braceStart = text.indexOf('{', idx);
  if (braceStart < 0) return null;
  let depth = 0;
  for (let i = braceStart; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(braceStart + 1, i);
    }
  }
  return null;   // unbalanced -> caller reports unknown
}

/** Top-level member names of an interface body, depth-aware. */
function topLevelKeys(body) {
  const keys = [];
  let depth = 0;
  let buf = '';
  for (const ch of body) {
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    if (depth === 0 && ch === ';') {
      const m = /^\s*'?([A-Za-z][\w-]*)'?\s*\??\s*:/.exec(buf);
      if (m) keys.push(m[1]);
      buf = '';
      continue;
    }
    buf += ch;
  }
  return keys;
}

/** Any index signature, regardless of the parameter's name. */
const hasIndexSignature = (body) => /\[\s*[A-Za-z_$][\w$]*\s*:\s*string\s*\]/.test(body);

const report = {
  fixture: null,
  contract: null,
  model_visibility: { established: false, note: 'not measured by this probe' },
  transcript: { established: false, note: 'not measured by this probe' },
  verdict: null,
  limits: [
    'No real QQ transport, no real credentials, no production state, temp dir only.',
    'A closed union in a type declaration is a STATIC contract finding, not a runtime rejection proof.',
    'Model-invisibility is NOT confidentiality from other processes in the same account.',
    'Nothing here shows whether a runtime keeps or leaks extra fields.',
  ],
};

let fixture = null;

try {
  const { loadOfflineHostFixture } = await import(new URL('scripts/qzone-host-prestep-fixture.mjs', WORKSPACE).href);
  fixture = await loadOfflineHostFixture();
  const llmTypes = path.join(fixture.tempRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-llm', 'lib', 'typert.host.js');
  report.fixture = { loaded: true, archive: path.basename(fixture.archive), llmTypesPresent: fs.existsSync(llmTypes) };

  const contract = {
    sourceMapFound: false,
    sourceMapKeyCount: null,
    sourceMapKeys: null,
    sourceMapHasIndexSignature: null,
    userRpcFields: null,
    principalMap: null,
    requestUserInput: null,
    errors: [],
  };

  if (!fs.existsSync(llmTypes)) {
    contract.errors.push('dsh-llm/lib/typert.host.js not found in the extracted fixture');
  } else {
    const text = fs.readFileSync(llmTypes, 'utf8').replace(/\\n/g, '\n');

    const sourceBody = extractInterfaceBody(text, 'MessageSourceMap');
    if (sourceBody === null) {
      contract.errors.push('MessageSourceMap declaration not found or unbalanced -> unknown');
    } else {
      const keys = topLevelKeys(sourceBody);
      contract.sourceMapFound = true;
      contract.sourceMapKeyCount = keys.length;
      contract.sourceMapKeys = keys;
      contract.sourceMapHasIndexSignature = hasIndexSignature(sourceBody);
      const rpc = /'user-rpc'\s*:\s*\{([^}]*)\}/.exec(sourceBody);
      contract.userRpcFields = rpc ? rpc[1].replace(/\s+/g, ' ').trim() : null;
    }

    const principalBody = extractInterfaceBody(text, 'PrincipalMap');
    contract.principalMap = principalBody === null
      ? null
      : { keys: topLevelKeys(principalBody), body: principalBody.replace(/\s+/g, ' ').trim().slice(0, 300) };

    const requestBody = extractInterfaceBody(text, 'RequestUserInput');
    contract.requestUserInput = requestBody === null
      ? null
      : { body: requestBody.replace(/\s+/g, ' ').trim().slice(0, 300) };
  }

  // Interpretation, stated narrowly.
  const closed = contract.sourceMapHasIndexSignature === false && contract.sourceMapFound === true;
  contract.interpretation = closed
    ? 'MessageSource is a closed union with no index signature: a CUSTOM proof field is not part of the '
      + 'declared contract. This is a STATIC finding; it does not prove the runtime rejects extras.'
    : 'Source union not classified (missing/unparseable/index-signature present) -> treat custom-field carriage as unknown.';
  contract.clientCannotSetSource = contract.requestUserInput
    ? /source\?\s*:\s*never/.test(contract.requestUserInput.body)
    : null;
  report.contract = contract;
} catch (error) {
  report.fixture = { loaded: false, error: String(error?.message ?? error) };
} finally {
  try { fixture?.close?.(); } catch {}
}

report.verdict = {
  customProofMetadataInSourceContract: report.contract?.sourceMapHasIndexSignature === false ? false : 'unknown',
  // The association key exists and is `rpcId`; it is a CORRELATION key, not a per-call proof.
  correlationKeyAvailable: 'rpcId',
  rpcIdIsProofOfAuthenticity: false,
  clientCanSetSourceDirectly: report.contract?.clientCannotSetSource === true ? false : 'unknown',
  modelVisibilityMeasured: false,
  transcriptMeasured: false,
  summary:
    'The host declares `user-rpc` with `rpcId` as the only QQ-inbound correlation carrier, and (per '
    + 'RequestUserInput) the client cannot set `source` itself. rpcId therefore serves as a LOOKUP key, '
    + 'NOT as proof that a given call actually happened: any process that can observe or self-report an '
    + 'rpcId can still swap callId/action/target. This does not close B3-11/B3-12, and it says nothing '
    + 'about model visibility or transcript contents.',
};

console.log(JSON.stringify(report, null, 2));
