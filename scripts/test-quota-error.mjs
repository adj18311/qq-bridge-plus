import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyQuotaError } from '../src/quota-error.js';

const SECRET_MARKER = 'SECRET-REQUEST-BODY-9f8e7d';

function assertContract(result) {
  assert.equal(typeof result, 'object');
  assert.notEqual(result, null);
  assert.deepEqual(Object.keys(result).sort(), ['exhausted', 'reason']);
  assert.equal(typeof result.exhausted, 'boolean');
  assert.equal(typeof result.reason, 'string');
  const dumped = JSON.stringify(result);
  for (const raw of [SECRET_MARKER, 'sk-live-1234567890', 'Bearer']) {
    assert.equal(dumped.includes(raw), false, 'result must not echo raw failure input');
  }
  return result;
}

function expectFalse(failure, label) {
  const result = assertContract(classifyQuotaError(failure));
  assert.equal(result.exhausted, false, label + ' must not be classified as quota exhaustion');
  return result;
}

function expectTrue(failure, label) {
  const result = assertContract(classifyQuotaError(failure));
  assert.equal(result.exhausted, true, label + ' must be classified as quota exhaustion');
  assert.ok(result.reason.length > 0, 'reason must be non-empty for exhaustion');
  return result;
}

test('generic HTTP 429 and rate limit failures are not quota exhaustion', () => {
  expectFalse({ status: 429, error: { status: 429, message: '429 Too Many Requests' } }, 'plain 429');
  expectFalse({ status: 429, error: { message: 'Rate limit reached for requests' } }, 'rate limit error');
  expectFalse({ error: { type: 'rate_limit_error', message: 'Too many requests' } }, 'rate_limit_error type');
});

test('structured depletion codes are recognized in error.code', () => {
  const codes = [
    'insufficient_quota',
    'insufficient_balance',
    'credit_balance_too_low',
    'quota_exceeded',
    'billing_hard_limit_reached',
    'usage_limit_exceeded',
    'coding_plan_exhausted',
  ];
  for (const code of codes) {
    expectTrue({ error: { code } }, 'error.code ' + code);
  }
});

test('structured depletion codes are recognized in error.type', () => {
  expectTrue({ error: { type: 'insufficient_quota' } }, 'type insufficient_quota');
  expectTrue({ error: { type: 'billing_hard_limit_reached' } }, 'type billing_hard_limit_reached');
  expectTrue({ error: { type: 'coding_plan_exhausted' } }, 'type coding_plan_exhausted');
});

test('structured depletion codes are matched case-insensitively', () => {
  expectTrue({ error: { code: 'INSUFFICIENT_QUOTA' } }, 'upper case code');
  expectTrue({ error: { code: 'Quota_Exceeded' } }, 'mixed case code');
});

test('structured depletion code in the cause wrapper is recognized', () => {
  expectTrue({ cause: { code: 'insufficient_balance' } }, 'cause code');
  expectTrue({ message: 'model call failed', cause: { type: 'credit_balance_too_low' } }, 'cause type');
});

test('clear English depletion prose is recognized', () => {
  expectTrue({ error: { message: 'You have exceeded your current quota. Please check your plan and billing details.' } }, 'quota exceeded prose');
  expectTrue({ message: 'Your credit balance is too low to access the API. Please add credits.' }, 'credit balance prose');
  expectTrue({ error: { message: 'You have reached your usage limit for this billing period.' } }, 'usage limit prose');
});

test('clear Chinese depletion prose is recognized', () => {
  expectTrue({ error: { message: '当前模型额度不足，请切换模型' } }, 'Chinese quota insufficient');
  expectTrue({ message: '账户余额不足，无法继续调用模型' }, 'Chinese balance insufficient');
  expectTrue({ error: { message: '配额已耗尽，请联系管理员' } }, 'Chinese quota exhausted');
});

test('nested JSON inside the allowed message field is unwrapped', () => {
  expectTrue({ error: { message: JSON.stringify({ error: { code: 'insufficient_quota', message: 'quota exhausted' } }) } }, 'nested error.code');
  expectTrue({ message: 'upstream: ' + JSON.stringify({ type: 'credit_balance_too_low' }) }, 'nested type');
});

test('nested JSON that only contains quota_limit stays false', () => {
  expectFalse({ error: { message: JSON.stringify({ error: { code: 'quota_limit' } }) } }, 'nested quota_limit');
});

test('request and prompt fields are never parsed for depletion signals', () => {
  expectFalse({ error: { message: 'Bad request' }, request: { prompt: 'insufficient_quota quota exhausted' } }, 'request.prompt');
  expectFalse({ error: { message: 'Model failed' }, prompt: 'insufficient_balance' }, 'prompt field');
  expectFalse({ error: { message: 'bad gateway' }, request: { body: 'credit_balance_too_low quota exceeded' } }, 'request.body');
});

test('HTTP headers are never parsed for depletion signals', () => {
  expectFalse({ message: 'Upstream failure', headers: { 'x-error-code': 'insufficient_quota' } }, 'headers x-error-code');
});

test('plain quota words and quota_limit are not exhaustion', () => {
  expectFalse({ error: { message: 'quota' } }, 'plain quota');
  expectFalse({ error: { code: 'quota_limit' } }, 'quota_limit code');
  expectFalse({ error: { message: 'The quota_limit setting is 100 requests per minute' } }, 'quota_limit prose');
});

test('token counts and context length errors are not quota exhaustion', () => {
  expectFalse({ error: { message: 'max_tokens exceeded: requested 8192 tokens' } }, 'token count');
  expectFalse({ error: { code: 'token_limit_exceeded' } }, 'token limit code');
  expectFalse({ error: { message: 'This model maximum context length is 128000 tokens' } }, 'context length');
});

test('insufficient permissions is not quota exhaustion', () => {
  expectFalse({ error: { message: 'insufficient permissions for this resource' } }, 'insufficient permissions');
  expectFalse({ error: { code: 'insufficient_permissions' } }, 'insufficient permissions code');
});

test('explicit authentication failures 401 and 403 stay false', () => {
  expectFalse({ status: 401, error: { code: 'insufficient_quota', message: 'Invalid API key' } }, '401 with billing-shaped code');
  expectFalse({ status: 401, error: { message: 'Authentication failed: insufficient_quota' } }, '401 auth prose');
  expectFalse({ status: 403, error: { code: 'credit_balance_too_low', message: 'Forbidden' } }, '403 with billing-shaped code');
  expectFalse({ status: 403, error: { code: 'billing_hard_limit_reached', message: 'Forbidden' } }, '403 billing hard limit');
});

test('overloaded and busy upstream failures 529 and 503 stay false', () => {
  expectFalse({ status: 529, error: { code: 'insufficient_quota', message: 'Overloaded' } }, '529 overloaded');
  expectFalse({ status: 503, error: { message: 'Service unavailable: insufficient_quota' } }, '503 unavailable');
  expectFalse({ status: 503, error: { code: 'quota_exceeded', message: 'upstream busy' } }, '503 quota code');
});

test('very long depletion payload is classified without echoing raw input', () => {
  const longMessage = SECRET_MARKER + ' insufficient_quota ' + 'x'.repeat(200000);
  const result = expectTrue({ error: { code: 'insufficient_quota', message: longMessage } }, 'long structured');
  assert.equal(JSON.stringify(result).includes(SECRET_MARKER), false);
});

test('adversarial long plain quota text does not become exhaustion', () => {
  const blob = 'quota '.repeat(50000) + ' tokens '.repeat(1000);
  expectFalse({ error: { message: blob } }, 'long plain text');
});

test('malformed or empty failures are safe and false', () => {
  const inputs = [null, undefined, {}, { error: {} }, { error: null }, { message: '' }, [], 42, 'plain failure'];
  for (const input of inputs) {
    const result = assertContract(classifyQuotaError(input));
    assert.equal(result.exhausted, false);
  }
});

test('result never echoes secrets from the failure payload', () => {
  const result = classifyQuotaError({
    error: {
      code: 'insufficient_quota',
      message: 'Authorization: Bearer sk-live-1234567890 ' + SECRET_MARKER,
    },
    headers: { authorization: 'Bearer sk-live-1234567890' },
  });
  assertContract(result);
  assert.equal(result.exhausted, true);
  assert.equal(JSON.stringify(result).includes('sk-live-1234567890'), false);
});

test('status-prefixed JSON respects auth and busy precedence', () => {
  for (const status of [401, 403, 503, 529]) {
    expectFalse({ message: `HTTP ${status} ` + JSON.stringify({ error: { code: 'insufficient_quota' } }) }, 'prefixed ' + status);
  }
});

test('JSON with a transport prefix still ignores request payload evidence', () => {
  expectFalse({ message: 'upstream: ' + JSON.stringify({ error: { message: 'bad request' }, request: { message: 'quota exhausted', prompt: '余额不足' } }) }, 'prefixed request');
});

test('minute-level usage or request limits are not exhausted account quota', () => {
  expectFalse({ message: 'Usage limit reached: 100 requests per minute. Retry after 60 seconds.' }, 'minute usage');
  expectFalse({ message: '每分钟调用次数已达上限，请稍后重试' }, 'minute Chinese requests');
});

test('a configured billing limit or unavailable quota is not proof of exhaustion', () => {
  expectFalse({ message: 'The billing hard limit is configured at 100 dollars' }, 'configured billing');
  expectFalse({ message: '额度暂时不可用，服务正在维护' }, 'quota service unavailable');
});

test('rate-limit code and current-minute window beat quota-shaped prose', () => {
  expectFalse({ status: 429, error: { type: 'rate_limit_exceeded', message: 'You exceeded your current quota for this minute; retry later.' } }, 'typed throttle');
  expectFalse({ status: 429, message: 'quota exceeded for this minute' }, 'minute window');
  expectTrue({ status: 429, error: { code: 'insufficient_quota', message: 'quota exhausted' } }, 'explicit billing on 429');
});

test('unrelated numbers are not authentication or busy status codes', () => {
  expectTrue({ message: 'Quota exhausted. Request id: 403.' }, 'unrelated request number');
});

test('ordinary provider tags and diagnostic suffixes retain clear exhaustion prose', () => {
  expectTrue({ message: '[OpenAI] insufficient_quota' }, 'provider tag');
  expectTrue({ message: 'You exceeded your current quota. [request id: abc123]' }, 'diagnostic suffix');
});

test('embedded JSON consumes the same cumulative depth budget', () => {
  let message = JSON.stringify({ error: { code: 'insufficient_quota' } });
  for (let i = 0; i < 7; i++) message = JSON.stringify({ message });
  expectFalse({ message }, 'deep embedded wrapper');
});
