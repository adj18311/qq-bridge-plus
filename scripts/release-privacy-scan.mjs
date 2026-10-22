#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = path.resolve(HERE, '..');
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const MAX_DEPTH = 64;
const BINARY_SNIFF = 8192;
const SKIP_DIR_NAMES = new Set(['.git', 'node_modules']);

const TEXT_RULES = [
  { id: 'windows-user-path', re: /[A-Za-z]:\\Users\\[^\\\r\n\x22'`<>|]{1,80}/g, kind: 'path' },
  { id: 'unix-home-path', re: /(?:^|[\s'`=])(\/(?:home|Users)\/[A-Za-z0-9._-]{1,64}\/)/g, kind: 'path', capture: 1 },
  { id: 'private-key-header', re: /-----BEGIN (?:[A-Z]{3,20} )?PRIVATE KEY-----/g, kind: 'private-key' },
  { id: 'credential-url', re: /https?:\/\/[^\/\s:@]{1,64}:[^\/\s@]{1,64}@/g, kind: 'url' },
  { id: 'known-token-literal', re: /(?:^|[^A-Za-z0-9])((?:sk|pk|rk|ghp|gho|ghu|ghs|ghr|github_pat|xox[abprs]|AKIA|ASIA)[A-Za-z0-9_-]{16,128})(?![A-Za-z0-9])/g, kind: 'secret', capture: 1 },
  { id: 'credential-assignment', re: /(?:^|[^A-Za-z0-9_$])(?:access[_-]?token|refresh[_-]?token|auth[_-]?token|api[_-]?key|client[_-]?secret|console[_-]?token|agent[_-]?token|launch[_-]?token|secret|password|passwd|token)["']?\s*[:=]\s*(["'`])([A-Za-z0-9_.\/+=-]{12,128})\1/gi, kind: 'assignment', capture: 2 },
  { id: 'credential-expression', re: /(?:^|[^A-Za-z0-9_$])(?:access[_-]?token|refresh[_-]?token|auth[_-]?token|api[_-]?key|client[_-]?secret|console[_-]?token|agent[_-]?token|launch[_-]?token|secret|password|passwd|token)["']?\s*[:=]\s*([A-Za-z_$][A-Za-z0-9_$.]*(?:\([^)\r\n]*\))?)/gi, kind: 'expression', capture: 1 },
  { id: 'qq-identifier', re: /(?:qq|uin|群号|群|ownerQQ|targetUserId|groupId|userId|账号)[ -~]{0,24}?[1-9][0-9]{8,10}(?![0-9])/gi, kind: 'qq' },
  { id: 'email-address', re: /(?:^|[^A-Za-z0-9._%+-])([A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,12})(?![A-Za-z0-9.-])/g, kind: 'email', capture: 1 },
];

const ARCHIVE_EXT = new Set(['.zip', '.7z', '.rar', '.tar', '.tar.gz', '.tgz', '.bz2', '.tbz2', '.xz', '.zst', '.cab', '.zipx']);
const OFFICE_EXT = new Set(['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp', '.rtf', '.pages', '.numbers', '.epub']);
const EMAIL_EXT = new Set(['.eml', '.msg', '.mbox', '.pst', '.ost', '.vcf', '.ics']);
const PRIVATE_EXT = new Set(['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore']);
const AUDIO_EXT = new Set(['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.opus']);
const SENSITIVE_DIR_NAMES = new Set(['state', 'audio', 'backup', 'backups', 'archive', 'archives', 'privatekey', 'private-key', 'cookie', 'cookies', 'office', 'email', 'screenshot', 'screenshots', 'personal', 'resume', '个人', '私人', '简历', '身份证', '护照', '证件', '合同', '工资', '薪资', '银行', '体检', '家庭', '通讯录', '聊天记录', '照片', '相册', '个人材料']);

function positiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) return fallback;
  return n;
}

function forbiddenDirectoryReason(rel) {
  const parts = rel.toLowerCase().split('/');
  for (const part of parts) {
    if (part === 'state') return 'state/ is local runtime data and is forbidden';
    if (part === 'audio') return 'audio/ is personal audio data and is forbidden';
    if (SENSITIVE_DIR_NAMES.has(part)) return 'sensitive directory is forbidden in the release copy';
  }
  return '';
}

function forbiddenFileReason(rel) {
  const lower = rel.toLowerCase();
  const parts = lower.split('/');
  const base = parts[parts.length - 1] || '';
  if (base === 'config.json') return 'local config.json is forbidden in the release copy';
  if (parts.includes('state')) return 'state/ is local runtime data and is forbidden';
  if (parts.includes('audio')) return 'audio/ is personal audio data and is forbidden';
  const ext = base.includes('.') ? base.slice(base.indexOf('.')) : '';
  if (ARCHIVE_EXT.has(ext)) return 'backup/archive file is forbidden';
  if (OFFICE_EXT.has(ext)) return 'office document is forbidden';
  if (EMAIL_EXT.has(ext)) return 'email/calendar file is forbidden';
  if (AUDIO_EXT.has(ext)) return 'audio file is forbidden';
  if (PRIVATE_EXT.has(ext)) return 'private key material is forbidden';
  if (/(?:^|[\\/_.-])(?:private[_-]?key|id_rsa|id_ecdsa|id_ed25519|cookies?|backups?|archives?|screenshots?)(?:[\\/_.-]|$)/i.test(lower)) return 'private key/cookie/backup/archive/screenshot artifact is forbidden';
  if (/(?:screenshot|screen[_-]?shot|截图|屏幕截图|截屏)/i.test(base)) return 'screenshot is forbidden';
  if (/(?:个人|私人|简历|resume|身份证|护照|证件|合同|工资|薪资|银行|体检|家庭|通讯录|聊天记录|照片|相册)/.test(base)) return 'personal material is forbidden';
  if (/(?:^|[\\/_.\s-])personal(?:[\\/_.\s-]|$)/i.test(lower)) return 'personal material is forbidden';
  return '';
}

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function lineAt(starts, index) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= index) lo = mid + 1;
    else hi = mid - 1;
  }
  return hi + 1;
}

function decodeBuffer(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { binary: false, text: buf.subarray(2).toString('utf16le') };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const copy = Buffer.from(buf.subarray(2));
    if (copy.length % 2 !== 0) return { binary: true, text: '' };
    copy.swap16();
    return { binary: false, text: copy.toString('utf16le') };
  }
  const n = Math.min(buf.length, BINARY_SNIFF);
  for (let i = 0; i < n; i += 1) {
    if (buf[i] === 0) return { binary: true, text: '' };
  }
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return { binary: false, text };
}

function isEnvReference(value) {
  return /^(?:process\.env|import\.meta\.env|os\.environ|env\[|getenv|config\.|settings\.|globalThis\.)/i.test(value) || /^[$<{\[]/.test(value);
}

function isHash(value) {
  return /^(?:[0-9a-f]{7,128}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(value)
    || /^sha(?:1|256|384|512)[-:]?[A-Za-z0-9+/=]{16,}$/i.test(value);
}

function isImageData(value) {
  return /^(?:data:image\/|iVBOR|\/9j\/|R0lGOD|UklGR)/i.test(value);
}

const FAKE_MARKER_RE = /(?:^|[_\-.\s])(?:your|example|placeholder|changeme|change[_-]?me|replace[_-]?me|dummy|fake|fixture|test|testing|mock|sample|redacted|canary|wrong|invalid|bogus|synthetic|verify|verification|not[-_]?a[-_]?real|notreal|insert|provide)(?:[_\-.\s]|$)/i;
const SYNTHETIC_NUMBER_RE = /0123456789|1234567890|9876543210/;

function isSyntheticQqIdentifier(id) {
  if (!/^[1-9][0-9]{8,10}$/.test(id)) return true;
  if (/0{6,}/.test(id)) return true;
  if (/([0-9])\1{6,}/.test(id)) return true;
  if (SYNTHETIC_NUMBER_RE.test(id)) return true;
  return false;
}

function isPlaceholder(value) {
  const s = String(value).trim();
  if (!s) return true;
  if (/^(?:null|undefined|true|false|none|nil)$/i.test(s)) return true;
  if (/[<>]/.test(s)) return true;
  if (FAKE_MARKER_RE.test(s)) return true;
  if (/^(?:x{3,}|\*{3,}|\.{3,}|_{3,}|-{3,})$/i.test(s)) return true;
  if (/^(?:1234567890?|9876543210?|0{6,}|1{6,}|9{6,})$/.test(s)) return true;
  if (SYNTHETIC_NUMBER_RE.test(s)) return true;
  return false;
}

function classifyLiteral(value) {
  if (!value) return 'placeholder';
  if (isEnvReference(value)) return 'env-reference';
  if (isHash(value)) return 'hash';
  if (isImageData(value)) return 'base64-image';
  if (isPlaceholder(value)) return 'placeholder';
  return 'ok';
}

function isPlaceholderPath(value) {
  return /<|>|(?:Users[\\/](?:public|default|username|user|name|yourname|example|fixture(?:[-_]?user)?|sample(?:[-_]?user)?|test(?:[-_]?user)?|dummy(?:[-_]?user)?)|(?:^|[\\/])(?:home|Users)[\\/](?:user|username|name|example|runner|fixture(?:[-_]?user)?|sample(?:[-_]?user)?)\b)/i.test(value);
}

function isReservedExampleDomain(domain) {
  const d = String(domain).toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!d) return true;
  if (d === 'localhost') return true;
  return /(?:^|\.)(?:example\.(?:com|org|net)|example|test|invalid|localhost)$/.test(d);
}

function isDocumentationUrl(afterUrl) {
  const host = String(afterUrl).match(/^([A-Za-z0-9.-]+)(?=[\/:?#]|$)/);
  return Boolean(host) && isReservedExampleDomain(host[1]);
}

// Only the exact third-party contact address already published in the shipped LICENSE is exempt.
// This allowlist is assembled from fragments so the scanner source file never contains an email literal.
const PUBLISHED_LICENSE_CONTACTS = new Set([
  ['motricseven', 'foxmail.com'].join('@').toLowerCase(),
]);

function isLicenseDocument(rel) {
  const base = String(rel).split('/').pop() || '';
  if (/^(?:licen[cs]e|unlicense|copying|copyright|notice)(?:\.[A-Za-z0-9]+)?$/i.test(base)) return true;
  return /(?:^|\/)(?:licen[cs]es?|third[-_]?party[-_]?notices)(?:\/|$)/i.test(String(rel));
}

// A license location exempts only the exact contacts already public there; any other address,
// including a newly added private address inside LICENSE, is reported as personal email.
function isPublishedLicenseContact(rel, value) {
  if (!isLicenseDocument(rel)) return false;
  return PUBLISHED_LICENSE_CONTACTS.has(String(value).toLowerCase());
}

function isPlaceholderEmail(value) {
  const lower = value.toLowerCase();
  const at = lower.lastIndexOf('@');
  if (at <= 0 || at === lower.length - 1) return true;
  const local = lower.slice(0, at);
  const domain = lower.slice(at + 1);
  if (isReservedExampleDomain(domain)) return true;
  if (/^(?:you|your|name|user|username|pass|password|test|tester|noreply|no-reply|git|bot|actions|dependabot|mail|email|foo|bar|baz|someone|somebody)$/.test(local)) return true;
  // Reserved example/test domains are classified above, before license-material handling.
  return false;
}

function scanExact(text, rel, starts, entries, add) {
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (!entry || typeof entry.value !== 'string' || entry.value.length < 4) continue;
    let at = text.indexOf(entry.value);
    while (at !== -1) {
      add(rel, lineAt(starts, at), 'external-' + entry.kind + '-' + (i + 1), 'exact sensitive value supplied by --sensitive-rules matched; value intentionally not printed');
      at = text.indexOf(entry.value, at + entry.value.length);
    }
  }
}

function scanText(text, rel, ctx, entries) {
  const starts = lineStarts(text);
  const seen = new Set();
  const report = (line, rule, explanation, key) => {
    if (key) {
      if (seen.has(key)) return;
      seen.add(key);
    }
    ctx.add(rel, line, rule, explanation);
  };
  for (const rule of TEXT_RULES) {
    rule.re.lastIndex = 0;
    let match;
    while ((match = rule.re.exec(text)) !== null) {
      if (rule.re.lastIndex === match.index) rule.re.lastIndex += 1;
      const raw = rule.capture ? match[rule.capture] : match[0];
      if (!raw) continue;
      const offset = rule.capture ? match.index + match[0].indexOf(raw) : match.index;
      const line = lineAt(starts, offset);
      if (rule.kind === 'secret' || rule.kind === 'assignment') {
        const verdict = classifyLiteral(raw);
        if (verdict !== 'ok') {
          ctx.classified[verdict] = (ctx.classified[verdict] || 0) + 1;
          continue;
        }
        report(line, rule.id, rule.kind === 'secret' ? 'token-like literal with a known provider prefix; move it to a secret store' : 'quoted credential literal; move it to a secret store or an environment/config reference', line + ':' + raw);
      } else if (rule.kind === 'expression') {
        const verdict = classifyLiteral(raw);
        const bucket = verdict === 'ok' ? 'expression' : verdict;
        ctx.classified[bucket] = (ctx.classified[bucket] || 0) + 1;
        continue;
      } else if (rule.kind === 'qq') {
        const found = raw.match(/[1-9][0-9]{8,10}/) || [''];
        const id = found[0];
        if (!id || isPlaceholder(id) || isSyntheticQqIdentifier(id)) {
          ctx.classified.placeholder += 1;
          continue;
        }
        report(line, rule.id, 'QQ/group identifier in a keyed context; verify it is not a real account', 'qq:' + line + ':' + id);
      } else if (rule.kind === 'path') {
        if (isPlaceholderPath(raw)) {
          ctx.classified.placeholder += 1;
          continue;
        }
        report(line, rule.id, 'absolute local user path; replace it with a relative path or documented placeholder', 'path:' + line + ':' + raw);
      } else if (rule.kind === 'url') {
        const afterUrl = text.slice(offset + match[0].length, offset + match[0].length + 160);
        if (isPlaceholder(raw) || isDocumentationUrl(afterUrl) || /(?:user|username|pass|password):(?:pass|password)/i.test(raw)) {
          ctx.classified.placeholder += 1;
          continue;
        }
        report(line, rule.id, 'URL with embedded credentials; remove credentials from the URL', 'url:' + line + ':' + raw);
      } else if (rule.kind === 'private-key') {
        report(line, rule.id, 'private key material header; never publish private keys');
      } else if (rule.kind === 'email') {
        if (isPlaceholderEmail(raw)) {
          ctx.classified.placeholder += 1;
          continue;
        }
        if (isPublishedLicenseContact(rel, raw)) {
          ctx.classified['license-public-contact'] = (ctx.classified['license-public-contact'] || 0) + 1;
          continue;
        }
        report(line, rule.id, 'personal email address; replace with a public project address or remove it', 'email:' + line + ':' + raw);
      }
    }
  }
  scanExact(text, rel, starts, entries, ctx.add);
}

function scanFile(file, ctx) {
  if (file.size > ctx.maxBytes) {
    ctx.errors += 1;
    ctx.skipped.oversized += 1;
    ctx.add(file.rel, 0, 'file-too-large', 'file size ' + file.size + ' exceeds --max-bytes ' + ctx.maxBytes + '; not read');
    return;
  }
  let buf;
  try {
    buf = fs.readFileSync(file.abs);
  } catch {
    ctx.errors += 1;
    ctx.skipped.unreadable += 1;
    ctx.add(file.rel, 0, 'file-unreadable', 'file could not be read; not silently skipped');
    return;
  }
  ctx.scanned += 1;
  ctx.bytes += buf.length;
  const decoded = decodeBuffer(buf);
  if (decoded.binary) {
    ctx.skipped.binary += 1;
    const latin = buf.toString('latin1');
    scanExact(latin, file.rel, lineStarts(latin), ctx.exactEntries, ctx.add);
    return;
  }
  scanText(decoded.text, file.rel, ctx, ctx.exactEntries);
}

function walkDirectory(dir, rel, depth, ctx) {
  if (depth > MAX_DEPTH) {
    ctx.errors += 1;
    ctx.add(rel || '.', 0, 'max-depth-exceeded', 'directory nesting exceeds ' + MAX_DEPTH + '; not followed further');
    return;
  }
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    ctx.errors += 1;
    ctx.add(rel || '.', 0, 'directory-unreadable', 'directory could not be read; not silently skipped');
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const childRel = rel ? rel + '/' + entry.name : entry.name;
    const abs = path.join(dir, entry.name);
    let st;
    try {
      st = fs.lstatSync(abs);
    } catch {
      ctx.errors += 1;
      ctx.add(childRel, 0, 'entry-unreadable', 'entry could not be inspected; not silently skipped');
      continue;
    }
    if (st.isSymbolicLink()) {
      ctx.skipped.symlinks += 1;
      ctx.add(childRel, 0, 'symlink-not-followed', 'symbolic link or junction reported but not followed');
      continue;
    }
    if (st.isDirectory()) {
      const nameLower = entry.name.toLowerCase();
      if (SKIP_DIR_NAMES.has(nameLower)) {
        if (nameLower === '.git') ctx.skipped.directories.git += 1;
        else ctx.skipped.directories.node_modules += 1;
        continue;
      }
      const reason = forbiddenDirectoryReason(childRel);
      if (reason) {
        ctx.skipped.directories.forbidden += 1;
        ctx.add(childRel + '/', 0, 'forbidden-directory', reason);
        continue;
      }
      walkDirectory(abs, childRel, depth + 1, ctx);
      continue;
    }
    if (st.isFile()) {
      const reason = forbiddenFileReason(childRel);
      if (reason) {
        ctx.skipped.forbiddenFiles += 1;
        ctx.add(childRel, 0, 'forbidden-file', reason);
        continue;
      }
      scanFile({ abs, rel: childRel, size: st.size }, ctx);
      continue;
    }
    ctx.skipped.other += 1;
    ctx.add(childRel, 0, 'unsupported-file-type', 'non-regular file reported but not read');
  }
}

export function scanRelease(options = {}) {
  const root = path.resolve(options.root || DEFAULT_ROOT);
  const maxBytes = positiveInt(options.maxBytes, DEFAULT_MAX_BYTES);
  const exactEntries = Array.isArray(options.exactEntries) ? options.exactEntries : [];
  const findings = [];
  const seenFindings = new Set();
  const add = (rel, line, rule, explanation) => {
    const safeRel = String(rel).split(path.sep).join('/');
    const item = {
      path: safeRel,
      line: Number.isInteger(line) ? line : 0,
      rule: String(rule),
      explanation: String(explanation),
    };
    const key = item.path + String.fromCharCode(0) + item.line + String.fromCharCode(0) + item.rule + String.fromCharCode(0) + item.explanation;
    if (seenFindings.has(key)) return;
    seenFindings.add(key);
    findings.push(item);
  };
  const ctx = {
    root,
    maxBytes,
    exactEntries,
    add,
    scanned: 0,
    bytes: 0,
    errors: 0,
    skipped: {
      directories: { git: 0, node_modules: 0, forbidden: 0 },
      symlinks: 0,
      forbiddenFiles: 0,
      binary: 0,
      oversized: 0,
      unreadable: 0,
      other: 0,
    },
    classified: { placeholder: 0, 'env-reference': 0, hash: 0, 'base64-image': 0, expression: 0, 'license-public-contact': 0 },
  };
  let stat;
  try {
    stat = fs.statSync(root);
  } catch {
    throw new Error('scan root is missing or unreadable');
  }
  if (!stat.isDirectory()) throw new Error('scan root is not a directory');
  walkDirectory(root, '', 0, ctx);
  if (ctx.scanned === 0) {
    ctx.errors += 1;
    ctx.add('.', 0, 'no-files-scanned', 'no scannable regular files were found under the release root');
  }
  const exitCode = findings.length > 0 || ctx.errors > 0 ? 1 : 0;
  return {
    root: '.',
    scanned: ctx.scanned,
    bytes: ctx.bytes,
    skipped: ctx.skipped,
    classified: ctx.classified,
    errors: ctx.errors,
    findings,
    findingCount: findings.length,
    exitCode,
  };
}

export function loadSensitiveRules(file) {
  let text;
  try {
    text = fs.readFileSync(path.resolve(file), 'utf8');
  } catch {
    throw new Error('sensitive rules file is not readable');
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('sensitive rules file is not valid JSON');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('sensitive rules must be an object');
  const entries = [];
  const add = (value, kind) => {
    if (typeof value !== 'string') return;
    const v = value.trim();
    if (v.length < 4) return;
    entries.push({ value: v, kind });
  };
  if (Array.isArray(data.exactSecrets)) for (const value of data.exactSecrets) add(value, 'secret');
  if (Array.isArray(data.exactPaths)) for (const value of data.exactPaths) add(value, 'path');
  if (Array.isArray(data.exactQqIds)) for (const value of data.exactQqIds) add(value, 'qq');
  if (Array.isArray(data.exactValues)) {
    for (const item of data.exactValues) {
      if (typeof item === 'string') add(item, 'secret');
      else if (item && typeof item.value === 'string') {
        const kind = item.kind === 'path' || item.kind === 'qq' ? item.kind : 'secret';
        add(item.value, kind);
      }
    }
  }
  const seen = new Set();
  const unique = entries.filter((entry) => {
    const key = entry.kind + String.fromCharCode(0) + entry.value;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!unique.length) throw new Error('sensitive rules file has no usable exact values');
  return unique;
}

function takeValue(argv, index, name) {
  if (index + 1 >= argv.length) throw new Error('missing value for ' + name);
  return argv[index + 1];
}

function parsePositive(value, name) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(name + ' must be a positive integer');
  return n;
}

export function parseArgs(argv) {
  const opts = { root: DEFAULT_ROOT, json: false, selfTest: false, sensitiveRules: null, maxBytes: DEFAULT_MAX_BYTES, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--self-test') {
      opts.selfTest = true;
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--root') {
      opts.root = path.resolve(takeValue(argv, i, '--root'));
      i += 1;
    } else if (arg.startsWith('--root=')) {
      opts.root = path.resolve(arg.slice(7));
    } else if (arg === '--sensitive-rules') {
      opts.sensitiveRules = takeValue(argv, i, '--sensitive-rules');
      i += 1;
    } else if (arg.startsWith('--sensitive-rules=')) {
      opts.sensitiveRules = arg.slice(18);
    } else if (arg === '--max-bytes') {
      opts.maxBytes = parsePositive(takeValue(argv, i, '--max-bytes'), '--max-bytes');
      i += 1;
    } else if (arg.startsWith('--max-bytes=')) {
      opts.maxBytes = parsePositive(arg.slice(12), '--max-bytes');
    } else {
      throw new Error('unknown argument; use --help');
    }
  }
  return opts;
}

function printUsage() {
  console.log('usage: node scripts/release-privacy-scan.mjs [--json] [--self-test] [--root DIR] [--max-bytes N] [--sensitive-rules FILE]');
}

function printHuman(result) {
  console.log('[release-privacy-scan] scanned=' + result.scanned + ' bytes=' + result.bytes + ' errors=' + result.errors + ' findings=' + result.findingCount + ' exitCode=' + result.exitCode);
  console.log('[release-privacy-scan] skipped=' + JSON.stringify(result.skipped));
  console.log('[release-privacy-scan] classified=' + JSON.stringify(result.classified));
  for (const finding of result.findings) {
    console.log('- ' + finding.path + ':' + finding.line + ' [' + finding.rule + '] ' + finding.explanation);
  }
}

function writeFixture(root, rel, content) {
  const abs = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

export function runSelfTest() {
  const checks = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-privacy-scan-'));
  const rulesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'release-privacy-rules-'));
  const check = (ok, name) => {
    if (!ok) throw new Error(name);
    checks.push(name);
  };
  try {
    const bs = String.fromCharCode(92);
    const nl = String.fromCharCode(10);
    const secret = ['sk', 'live', 'A1b2C3d4E5f6G7h8'].join('-');
    const exact = ['EXACT', 'SECRET', '9f3a2b1c'].join('-');
    const ownerQq = ['2876', '543210'].join('');
    const sampleUser = 'release-user';
    const licenseContact = ['motricseven', 'foxmail.com'].join('@');
    const unpublishedLicenseContact = ['private', 'owner', '7f3d'].join('.') + '@' + ['gmail', 'com'].join('.');
    writeFixture(root, '.git/config', 'ignored' + nl);
    writeFixture(root, 'node_modules/pkg/index.js', 'ignored' + nl);
    writeFixture(root, 'config.json', '{}' + nl);
    writeFixture(root, 'state/data.txt', 'ignored' + nl);
    writeFixture(root, 'backup.zip', 'x' + nl);
    writeFixture(root, 'img/screenshot.png', 'x' + nl);
    writeFixture(root, '个人材料/简历.md', 'x' + nl);
    writeFixture(root, 'src/leak.js', [
      'const token = ' + JSON.stringify(secret) + ';',
      'const ownerQQ = ' + ownerQq + ';',
      "const p = 'C:" + bs + "Users" + bs + sampleUser + bs + "work';",
      "const apiKey = 'YOUR_API_KEY_HERE';",
    ].join(nl));
    writeFixture(root, 'docs/README.md', 'C:' + bs + 'Users' + bs + sampleUser + bs + 'notes' + nl);
    writeFixture(root, 'src/exact.js', `const x = '${exact}';` + nl);
    writeFixture(root, 'LICENSE', 'Copyright (c) 2026 Example' + nl + 'Public contact: ' + licenseContact + nl + 'New private contact: ' + unpublishedLicenseContact + nl);
    const rulesPath = path.join(rulesRoot, 'rules.json');
    fs.writeFileSync(rulesPath, JSON.stringify({ exactSecrets: [exact] }), 'utf8');
    const result = scanRelease({ root, maxBytes: 4096, exactEntries: loadSensitiveRules(rulesPath) });
    const serialized = JSON.stringify(result);
    check(result.findingCount > 0, 'findings are produced');
    check(result.skipped.directories.git === 1, '.git is skipped and counted');
    check(result.skipped.directories.node_modules === 1, 'node_modules is skipped and counted');
    check(result.findings.some((f) => f.rule === 'forbidden-file'), 'forbidden files are reported');
    check(result.findings.some((f) => f.path === 'docs/README.md' && f.rule === 'windows-user-path'), 'nested README is scanned');
    check(result.findings.some((f) => f.rule === 'credential-assignment' || f.rule === 'known-token-literal'), 'hardcoded secrets are reported');
    check(result.findings.some((f) => f.rule.startsWith('external-secret-')), 'external exact secrets are matched');
    check(result.classified.placeholder >= 1, 'placeholder literals are classified');
    check(!serialized.includes(secret), 'secret value is not serialized');
    check(!serialized.includes(sampleUser), 'placeholder path fragment is not serialized');
    check(result.classified['license-public-contact'] >= 1, 'published license contact is recorded as license material');
    check(result.findings.filter((f) => f.path === 'LICENSE' && f.rule === 'email-address').length === 1, 'only the unpublished LICENSE email is reported');
    check(!serialized.includes(unpublishedLicenseContact), 'unpublished LICENSE email value is not serialized');
    check(!serialized.includes(exact), 'external exact value is not serialized');
    check(result.findings.every((f) => Object.keys(f).sort().join(',') === 'explanation,line,path,rule'), 'findings contain only safe fields');
    return { selfTest: 'pass', checks };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(rulesRoot, { recursive: true, force: true });
  }
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    console.error('[release-privacy-scan] ' + error.message);
    process.exitCode = 2;
    return;
  }
  if (opts.help) {
    printUsage();
    return;
  }
  if (opts.selfTest) {
    try {
      const result = runSelfTest();
      if (opts.json) console.log(JSON.stringify(result, null, 2));
      else console.log('[release-privacy-scan] self-test PASS (' + result.checks.length + ' checks)');
      process.exitCode = 0;
    } catch {
      console.error('[release-privacy-scan] self-test FAIL');
      process.exitCode = 1;
    }
    return;
  }
  let exactEntries = [];
  if (opts.sensitiveRules) {
    try {
      exactEntries = loadSensitiveRules(opts.sensitiveRules);
    } catch (error) {
      console.error('[release-privacy-scan] ' + error.message);
      process.exitCode = 2;
      return;
    }
  }
  let result;
  try {
    result = scanRelease({ root: opts.root, maxBytes: opts.maxBytes, exactEntries });
  } catch (error) {
    console.error('[release-privacy-scan] ' + error.message);
    process.exitCode = 2;
    return;
  }
  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else printHuman(result);
  process.exitCode = result.exitCode;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const scriptPath = fileURLToPath(import.meta.url);
const isDirectRun = process.platform === 'win32' ? invokedPath.toLowerCase() === scriptPath.toLowerCase() : invokedPath === scriptPath;
if (isDirectRun) main(process.argv.slice(2));
