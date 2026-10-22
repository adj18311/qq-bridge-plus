import assert from 'node:assert/strict';
import test from 'node:test';

let mod = null;
try { mod = await import(new URL('../src/retry-diagnostic.js', import.meta.url)); } catch (_) { mod = null; }
if (!mod) { console.error('FAIL: cannot import src/retry-diagnostic.js'); process.exit(1); }
const fmt = mod.formatRetryDiagnostic || (mod.default && mod.default.formatRetryDiagnostic);
if (typeof fmt !== 'function') { console.error('FAIL: formatRetryDiagnostic export missing'); process.exit(1); }

const has = (out, ...xs) => xs.forEach((x) => assert.ok(out.includes(x), 'missing: ' + x));
const lacks = (out, ...xs) => xs.forEach((x) => assert.ok(!out.includes(x), 'leaked: ' + x));
const json = (o) => JSON.stringify(o);

test('JSON: only allowed diagnostic fields', () => {
  const out = fmt({ status: 529, message: '529 ' + json({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' }, request_id: 'req_1', headers: { Authorization: 'Bearer HSECRET' }, request: { messages: [{ content: 'RBODY' }] } }) });
  has(out, 'status=529', 'error.type=overloaded_error', 'error.message=Overloaded', 'request_id=req_1');
  lacks(out, 'HSECRET', 'RBODY', 'headers', '"error"', 'messages');
});

test('nested JSON error.message', () => {
  const out = fmt({ status: 503, message: '503 ' + json({ error: { type: 'overloaded_error', message: json({ type: 'inner', message: 'deep fail', request_id: 'req_nested' }) } }) });
  has(out, 'deep fail', 'request_id=req_nested');
  lacks(out, '{');
});

test('plain text: whole credential values removed', () => {
  const out = fmt({ status: 503, message: 'HTTP 503 error\nAuthorization: Bearer AUTHCRED\nCookie: sid=COOKIECRED; theme=dark\ntoken=TOKENCRED\nrequest_id=req_plain' });
  has(out, 'HTTP 503 error', 'request_id=req_plain');
  lacks(out, 'AUTHCRED', 'COOKIECRED', 'TOKENCRED');
});

test('injected known-token redaction is retained', () => {
  const out = fmt({ status: 529, message: 'HTTP 529 INJECTME' }, { redact: (s) => s.replace(/INJECTME/g, '[X]') });
  has(out, '[X]');
  lacks(out, 'INJECTME');
});

test('CRLF log injection collapsed', () => {
  const out = fmt({ message: 'HTTP 529 error\r\nAuthorization: Bearer CRLFCRED\r\nrequest_id=req_crlf' });
  has(out, 'req_crlf', 'HTTP 529 error');
  lacks(out, '\n', '\r', 'CRLFCRED');
});

test('ordinary error text and request_id retained', () => {
  const out = fmt({ status: 503, message: 'upstream HTTP 503 service unavailable; request_id=req_keep; try later' });
  has(out, 'status=503', 'service unavailable', 'request_id=req_keep');
  lacks(out, 'unparseable-json');
});

test('truncation after masking respects maxChars', () => {
  const out = fmt({ status: 529, message: 'HTTP 503 Authorization: Bearer TRUNCSECRET token=TRUNCTOKEN ' + 'x'.repeat(400) }, { maxChars: 60 });
  assert.ok(out.length <= 60, 'length ' + out.length);
  lacks(out, 'TRUNCSECRET', 'TRUNCTOKEN');
});

test('invalid JSON fails closed', () => {
  const out = fmt({ status: 529, message: '529 {"error":{"type":"x","message":"boom"},"headers":{"Authorization":"Bearer BADSECRET"' });
  has(out, 'unparseable-json');
  lacks(out, 'BADSECRET', 'boom', '"error"');
});

test('empty and non-string inputs', () => {
  assert.equal(fmt(null), '');
  assert.equal(fmt(undefined), '');
  assert.equal(fmt('503 boom'), '');
  assert.equal(fmt({ message: 123 }), '');
});

test('input object not mutated', () => {
  const failure = { status: 529, message: '529 {"error":{"type":"x","message":"boom"},"headers":{"Authorization":"Bearer S"}}', requestId: 'req_x', headers: { a: 1 } };
  const before = json(failure);
  fmt(failure, { redact: (s) => s });
  assert.equal(json(failure), before);
});

test('URL credentials masked', () => {
  const out = fmt({ status: 503, message: 'HTTP 503 see https://user:URLPASS@example.com/path?token=QTOKEN now' });
  has(out, 'example.com');
  lacks(out, 'URLPASS', 'QTOKEN');
});

test('prompt/input lines dropped entirely', () => {
  const out = fmt({ status: 503, message: 'HTTP 503 unavailable\nprompt: SECRETPROMPT\ninput=RAWINPUT\nrequest_id=req_body' });
  has(out, 'HTTP 503 unavailable', 'req_body');
  lacks(out, 'SECRETPROMPT', 'RAWINPUT');
});

test('request_id not mistaken for status', () => {
  const out = fmt({ status: 529, message: 'request_id=req_9 HTTP 529 overloaded' });
  has(out, 'request_id=req_9', 'status=529');
  assert.ok(!/status=9\b/.test(out));
});

test('generic redaction cannot erase a header label before its full value is removed', () => {
  const redact = value => value.replace(/Authorization:\s*Bearer/g, '***');
  const out = fmt({ status: 503, message: '503 unavailable\nAuthorization: Bearer still-secret\nrequest_id=req_safe' }, { redact });
  lacks(out, 'still-secret');
  has(out, 'req_safe');
});

test('HTTP-prefixed JSON drops request bodies and headers', () => {
  const out = fmt({ status: 503, message: 'HTTP 503 ' + json({ error: { message: 'unavailable' }, headers: { Authorization: 'Bearer secret-x' }, request: { messages: ['private-x'] } }) });
  has(out, 'unavailable');
  lacks(out, 'secret-x', 'private-x');
});

test('quoted and Basic authorization values are removed in full', () => {
  for (const value of ['Basic basic-secret', '"Basic quoted-secret"', "'Bearer quoted-bearer'"]) {
    const out = fmt({ status: 503, message: `503 busy\nAuthorization: ${value}\nrequest_id=req_auth` }, { redact: s => s.replace(/Authorization:\s*["']?Basic/g, '***') });
    lacks(out, 'basic-secret', 'quoted-secret', 'quoted-bearer');
    has(out, 'req_auth');
  }
});
