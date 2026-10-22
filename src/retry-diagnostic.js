'use strict';
const PAYLOAD_LINE = /(?:^|[\s{,])(?:"?(?:prompt|input|messages|body|headers?|credentials)"?)\s*[:=]/i;
const AUTH = /((?:"?(?:proxy-)?authorization"?)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|(?:bearer|basic)\s+[^\s,;"']+|[^\s,;"']+)/gi;
const COOKIE = /((?:"?cookie"?)\s*[:=]\s*)[^\r\n]+/gi;
const ASSIGN = /((?:"?(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|passwd|secret|session(?:[_-]?id)?)"?)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const BEARER = /(bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const URLCRED = /([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi;
const QUERYCRED = /([?&](?:access_token|token|api_key|key|secret|password|sig|signature)=)[^&\s#]+/gi;
const CTRL = /[\u0000-\u001f\u007f]+/g;

function mask(text, redact) {
  let out = String(text);
  out = out.split(/\r\n|\r|\n/).filter((line) => !PAYLOAD_LINE.test(line)).join('\n');
  out = out.replace(AUTH, '$1[redacted]').replace(COOKIE, '$1[redacted]').replace(ASSIGN, '$1[redacted]').replace(BEARER, '$1[redacted]').replace(URLCRED, '$1[redacted]@').replace(QUERYCRED, '$1[redacted]');
  // Remove whole credential values before generic path/token redaction can erase their labels.
  try { const r = redact(out); out = typeof r === 'string' ? r : '[redaction-failed]'; } catch (_) { out = '[redaction-failed]'; }
  return out.replace(CTRL, ' ').replace(/\s+/g, ' ').trim();
}

function short(value) {
  const s = typeof value === 'string' ? value : (typeof value === 'number' || typeof value === 'boolean' ? String(value) : '');
  return s.replace(CTRL, '').replace(/\s+/g, '').slice(0, 80);
}

function extract(obj, depth) {
  if (!obj || typeof obj !== 'object' || depth > 4) return { type: '', message: '', requestId: '' };
  const err = obj.error && typeof obj.error === 'object' ? obj.error : obj;
  const type = typeof err.type === 'string' && err.type !== 'error' ? err.type : '', message = typeof err.message === 'string' ? err.message : '';
  const requestId = short(obj.request_id) || short(obj.requestId);
  if (!/^[[{]/.test(message.trim())) return { type, message, requestId };
  try {
    const sub = extract(JSON.parse(message.trim()), depth + 1);
    return { type: type || sub.type, message: sub.message || '[unparseable-json]', requestId: requestId || sub.requestId };
  } catch (_) { return { type, message: '[unparseable-json]', requestId }; }
}

function formatRetryDiagnostic(failure, options) {
  const opts = options || {};
  if (!failure || typeof failure !== 'object') return '';
  const redact = typeof opts.redact === 'function' ? opts.redact : (x) => x;
  const message = typeof failure.message === 'string' ? failure.message : '';
  const m = /^\s*(?:HTTP(?:\/\d+(?:\.\d+)?)?\s+)?([45]\d\d)(?=\s|$)/i.exec(message), rest = (m ? message.slice(m[0].length) : message).trim();
  const status = short(failure.status) || (m ? m[1] : '');
  const code = short(failure.code), metaRid = mask(short(failure.requestId) || short(failure.request_id), redact);
  const parts = [];
  if (status) parts.push('status=' + mask(status, redact));
  if (code) parts.push('code=' + mask(code, redact));
  if (!/^[[{]/.test(rest)) {
    const text = mask(message, redact);
    if (text) parts.push('message=' + text);
    if (metaRid) parts.push('request_id=' + metaRid);
  } else {
    let parsed = null;
    try { parsed = JSON.parse(rest); } catch (_) { parsed = null; }
    if (parsed && typeof parsed === 'object') {
      const d = extract(parsed, 0);
      if (d.type) parts.push('error.type=' + mask(short(d.type), redact));
      if (d.message) parts.push('error.message=' + mask(d.message, redact));
      const rid = mask(short(d.requestId), redact) || metaRid;
      if (rid) parts.push('request_id=' + rid);
    } else {
      parts.push('error.message=[unparseable-json]');
      if (metaRid) parts.push('request_id=' + metaRid);
    }
  }
  if (typeof failure.providerRetryAfterMs === 'number' && Number.isFinite(failure.providerRetryAfterMs)) parts.push('providerRetryAfterMs=' + failure.providerRetryAfterMs);
  const n = Number.isFinite(opts.maxChars) ? Math.max(0, Math.floor(opts.maxChars)) : 500, joined = parts.join(' ');
  return joined.length <= n ? joined : (n <= 1 ? joined.slice(0, Math.max(0, n)) : joined.slice(0, n - 1) + '…');
}
export { formatRetryDiagnostic };
