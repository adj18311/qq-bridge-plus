// task-133 终审②：真实 controller → hook → authorize/commit 的写门禁竞争测试（离线）。
// 覆盖：已 commit 的 pending 写会阻断第二笔写；读放行；用户来源（owner）同样阻断；
//        authorize→commit 之间出现 pending 时 commit 拒绝且票据保持 reserved。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createBackgroundPatrolBridgeHook } from "../src/core/background-patrol-bridge-hook.mjs";
import { postJson } from "./test-port-safe.mjs";

const BG = "patrol:background";
const OWNER_QQ = 123456789;
const TOKEN = "task133-write-gate-token-0123456789abcdef";
const NOW = Date.now();

function baseState() {
  return {
    schemaVersion: 1,
    day: "2026-10-27",
    lastSeenAt: NOW,
    readCount: 0,
    buckets: { post: { count: 0, lastActionAt: null }, comment: { count: 0, lastActionAt: null } },
    operations: {},
    consecutiveWriteFailures: 0,
    writePaused: false,
    writeReason: null,
    accessPaused: false,
    accessReason: null,
    transitionEvents: [],
    transitionEventOverflow: 0,
  };
}

function fakeLedger() {
  return {
    enqueue: async () => ({ ok: true, id: "seen", duplicate: true }),
    isDelivered: async () => ({ ok: true, delivered: true }),
  };
}

async function withHook(fn, extras = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "patrol-write-gate-"));
  const storePath = path.join(dir, "controller.json");
  await writeFile(storePath, JSON.stringify(baseState()), "utf8");
  const sessions = { [BG]: "fixture-session", [`private:${OWNER_QQ}`]: "owner-session" };
  const hook = createBackgroundPatrolBridgeHook({
    config: { backgroundPatrol: { enabled: true, platforms: { tieba: true, xiaoheihe: true }, groupExempt: true } },
    consoleToken: TOKEN,
    controllerStorePath: storePath,
    ownerQQ: OWNER_QQ,
    sessions,
    sessionsProvider: () => sessions,
    backgroundSessionId: "fixture-session",
    port: 0,
    logger: { warn() {}, error() {} },
    ...extras,
  });
  try {
    const started = await hook.start();
    assert.equal(started.ok, true, JSON.stringify(started));
    await hook.reconcile(fakeLedger());
    return await fn({ hook, url: started.url });
  } finally {
    await hook.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const post = (url, body) => postJson(url, body, { "x-console-token": TOKEN });
const authorize = async (url, agentKey, tool, operationId) => {
  const body = { agentKey, tool, ...(operationId === undefined ? {} : { args: { operationId } }) };
  const response = await post(`${url}/api/xiaoheihe/authorize`, body);
  return { status: response.status, body: await response.json() };
};
const commit = async (url, ticket, agentKey) => {
  const response = await post(`${url}/api/xiaoheihe/commit`, { ticket, agentKey });
  return { status: response.status, body: await response.json() };
};
const abort = async (url, ticket, agentKey) => {
  const response = await post(`${url}/api/xiaoheihe/abort`, { ticket, agentKey });
  return { status: response.status, body: await response.json() };
};
const complete = async (url, ticket, agentKey, outcome) => {
  const response = await post(`${url}/api/xiaoheihe/complete`, { ticket, agentKey, outcome });
  return { status: response.status, body: await response.json() };
};

test("已 commit 的 pending 写会阻断第二笔写；读放行；complete 后恢复", async () => {
  await withHook(async ({ url }) => {
    // task-49：patrol 来源写已被可信边界拒绝（覆盖见 test-read-only-gate.mjs 的 task-49 用例），
    // 本用例只验证 pending 写竞争，写样本改用 owner 会话；读样本仍留 patrol（读不受门禁影响）。
    const first = await authorize(url, "owner-session", "mcp__xiaoheihe__post_comment", "op-first");
    assert.equal(first.body.decision, "allow", JSON.stringify(first.body));
    const committed = await commit(url, first.body.ticket, "owner-session");
    assert.equal(committed.body.started, true, JSON.stringify(committed.body));

    const second = await authorize(url, "owner-session", "mcp__xiaoheihe__post_comment", "op-second");
    assert.equal(second.body.decision, "deny", JSON.stringify(second.body));
    assert.equal(second.body.reason, "unconfirmed-write", JSON.stringify(second.body));

    const read = await authorize(url, "fixture-session", "mcp__xiaoheihe__get_home_content");
    assert.equal(read.body.decision, "allow", JSON.stringify(read.body));

    const done = await complete(url, committed.body.ticket, "owner-session", "success");
    assert.equal(done.body.ok, true, JSON.stringify(done.body));

    // 换发帖（post 桶）避免命中评论 3 分钟最小间隔；这里只验证门禁解除后允许新写。
    const third = await authorize(url, "owner-session", "mcp__xiaoheihe__publish_content", "op-third");
    assert.equal(third.body.decision, "allow", JSON.stringify(third.body));
  });
});

test("用户来源（owner 会话）在存在 pending 写时同样被拒绝", async () => {
  await withHook(async ({ url }) => {
    const first = await authorize(url, "owner-session", "mcp__xiaoheihe__post_comment", "op-owner-1");
    assert.equal(first.body.decision, "allow", JSON.stringify(first.body));
    const committed = await commit(url, first.body.ticket, "owner-session");
    assert.equal(committed.body.started, true, JSON.stringify(committed.body));

    const second = await authorize(url, "owner-session", "mcp__xiaoheihe__reply_comment", "op-owner-2");
    assert.equal(second.body.decision, "deny", JSON.stringify(second.body));
    assert.equal(second.body.reason, "unconfirmed-write", JSON.stringify(second.body));
  });
});

test("未知结果保留额度与防重放，但不阻断其他写入", async () => {
  await withHook(async ({ url, hook }) => {
    const first = await authorize(url, "owner-session", "mcp__xiaoheihe__post_comment", "op-unknown-policy");
    assert.equal(first.body.decision, "allow");
    const started = await commit(url, first.body.ticket, "owner-session");
    assert.equal(started.body.started, true);
    const done = await complete(url, started.body.ticket, "owner-session", "unknown");
    assert.equal(done.body.ok, true);
    const recon = await hook.reconcile(fakeLedger());
    assert.equal(recon.unknownWriteCount, 1);
    assert.equal(recon.blocked, false);
    const duplicate = await authorize(url, "owner-session", "mcp__xiaoheihe__post_comment", "op-unknown-policy");
    assert.equal(duplicate.body.decision, "deny");
    assert.equal(duplicate.body.reason, "unknown-not-replayable", JSON.stringify(duplicate.body));
    const next = await authorize(url, "owner-session", "mcp__xiaoheihe__publish_content", "op-after-unknown");
    assert.equal(next.body.decision, "allow", JSON.stringify(next.body));
  });
});

test("authorize→commit 竞争：另一笔 pending 存在时 commit 拒绝且票据保持 reserved", async () => {
  await withHook(async ({ url }) => {
    // 两个不同 kind 的写票据，避免被最小间隔规则先拒绝（task-49：写样本用 owner 会话）。
    const postTicket = await authorize(url, "owner-session", "mcp__xiaoheihe__publish_content", "op-post");
    assert.equal(postTicket.body.decision, "allow", JSON.stringify(postTicket.body));
    const commentTicket = await authorize(url, "owner-session", "mcp__xiaoheihe__reply_comment", "op-comment");
    assert.equal(commentTicket.body.decision, "allow", JSON.stringify(commentTicket.body));

    // 先 commit 评论，制造一个 pending 写。
    const committed = await commit(url, commentTicket.body.ticket, "owner-session");
    assert.equal(committed.body.started, true, JSON.stringify(committed.body));

    // 再 commit 发帖：authorize 之后状态已变，必须在 commit 边界拒绝。
    const rejected = await commit(url, postTicket.body.ticket, "owner-session");
    assert.equal(rejected.body.ok, false, JSON.stringify(rejected.body));
    assert.equal(rejected.body.reason, "unconfirmed-write", JSON.stringify(rejected.body));

    // 票据未被消耗：可 abort（空转），且不会留下 started。
    const rolled = await abort(url, postTicket.body.ticket, "owner-session");
    assert.equal(rolled.body.ok, true, JSON.stringify(rolled.body));
  });
});

// A-1：凭据类（登录/二维码）经真实 hook 的端到端语义 —— 拒绝必须带可执行提示，
// 放行必须走可追踪的 misc 生命周期，并在 complete 时向 owner 发一次归属通知。
test("A-1 凭据类经真实 hook：patrol 被拒且带提示；owner 放行并在 complete 时通知一次", async () => {
  const notified = [];
  await withHook(async ({ url }) => {
    const denied = await authorize(url, "fixture-session", "mcp__xiaoheihe__interactive_login");
    assert.equal(denied.body.decision, "deny", JSON.stringify(denied.body));
    assert.equal(denied.body.reason, "credential-requires-user-present");
    assert.equal(typeof denied.body.hint, "string");
    assert.ok(denied.body.hint.length > 0, "拒绝必须带可执行提示");
    assert.equal(notified.length, 0, "被拒时不得通知");

    const allowed = await authorize(url, "owner-session", "mcp__xiaoheihe__get_login_qr_code");
    assert.equal(allowed.body.decision, "allow", JSON.stringify(allowed.body));
    assert.equal(allowed.body.ticket.kind, "misc");
    const done = await complete(url, allowed.body.ticket, "owner-session", "success");
    assert.equal(done.body.ok, true, JSON.stringify(done.body));

    const again = await complete(url, allowed.body.ticket, "owner-session", "success");
    assert.equal(again.body.ok, true);
  }, { credentialNotify: async (event) => { notified.push(event); } });
  assert.equal(notified.length, 1, "同一次登录只通知一次");
  assert.equal(notified[0].tool, "get_login_qr_code");
  assert.equal(notified[0].outcome, "success");
  assert.equal(notified[0].agentKey, "owner-session");
});
