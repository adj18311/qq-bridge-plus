import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { NodeApiClient, createTurnCollector, unwrap } from './dsh-client.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:19387';
const DEFAULT_TIMEOUT_MS = 120_000;

function baseUrl() {
  return (process.env.DSH_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function client() {
  return new NodeApiClient(baseUrl(), DEFAULT_TIMEOUT_MS, { tokenExplicit: false });
}

function jsonText(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  };
}

function errorText(error) {
  return {
    content: [{ type: 'text', text: String(error?.message ?? error) }],
    isError: true,
  };
}

function tempWorkspaceDir() {
  return path.join(os.tmpdir(), 'codex-deepseek-harness');
}

async function call(method, payload, label) {
  return unwrap(await client().callUnary(method, payload ?? {}), label || method);
}

/**
 * 订阅一个会话的 turn 事件流，等「订阅之后才开始」的那个回合结束。
 *
 * 这段逻辑踩过三个坑，逐条修在这里：
 *
 * 1. **先订阅、再发 prompt。** 之前是并发发起（订阅与 session.prompt 同时打出去），
 *    turn/start 可能在 follow 生效前就被发走；而 DSH 的 session/follow 开场只补一份
 *    **快照**，不回放订阅窗口内的事件，于是 turn/end 永远等不到 → 只能干等到超时。
 *    现在拆成 openTurnWaiter() / ready / wait() 三步，由调用方在 ready 之后才发 prompt。
 *
 * 2. **只认「订阅之后才开始」的回合。** 快照带着该会话此前的历史回合，
 *    把第一个 turn/end 当结果会把上一轮的回答返回给调用方。
 *    baseline 取「快照里的最大 turn」与「session.list 的 turnOutline 最大 turn」的较大者。
 *
 * 3. **事件流会自己结束**（DSH 重启 / WS 抖动），而且活着的时候也可能漏事件。
 *    因此除了事件路径，还并行跑一条 session.list 轮询（短暂宽限后启动），
 *    谁先拿到结果用谁；轮询用 turnOutline 的 response 作为最终文本。
 *
 * @returns {{ turn:number, reason:string, text:string, source:'event'|'poll', elapsedMs:number }}
 */
const DEBUG = process.env.DSH_MCP_DEBUG === '1';
function debug(...args) { if (DEBUG) console.error('[deepseek-harness]', ...args); }

function openTurnWaiter(api, sessionId) {
  const collector = createTurnCollector();
  const abort = new AbortController();
  let baselineTurn = 0;   // 订阅完成时已存在的最大 turn（历史）
  let targetTurn = 0;     // 本轮开始后出现的 turn
  let baselineFrozen = false; // ready 完成后置位：此后的 turn/start 属于本轮
  let resolveOpen;
  const opened = new Promise((resolve) => { resolveOpen = resolve; });

  const stream = api.events.mux({}, abort.signal, () => resolveOpen());

  // 流一建好就开消费协程：事件到达即刻处理，不等调用方来取。
  let resolveEnded;
  let rejectEnded;
  const ended = new Promise((resolve, reject) => { resolveEnded = resolve; rejectEnded = reject; });
  (async () => {
    try {
      for await (const envelope of stream) {
        const frame = envelope?.payload ?? envelope;
        if (frame?.type === 'session/event' && frame.sessionId === sessionId) {
          const event = frame.event;
          if (event?.type === 'turn/start' && Number.isInteger(event?.data?.turn)) {
            // 只有**订阅期**（ready 之前，事件来自 follow 的开场快照）里的 turn/start 才算历史。
            // ready 之后本轮自己的 turn/start 若也抬 baseline，就会出现
            // 「turn/end.turn > baseline」永远不成立 → 永远等不到结果。
            if (baselineFrozen) targetTurn = Math.max(targetTurn, event.data.turn);
            else baselineTurn = Math.max(baselineTurn, event.data.turn);
            debug('event turn/start', event.data.turn, { baselineTurn, targetTurn, baselineFrozen });
          }
          const result = collector.push(event);
          if (result && result.turn > baselineTurn) {
            const shaped = { turn: result.turn, reason: typeof result.reason === 'string' ? result.reason : result.reason?.kind ?? 'completed', text: result.text, source: 'event' };
            debug('event result', shaped);
            resolveEnded(shaped);
            return;
          }
        }
        if (frame?.type === 'stream/error') throw new Error('DeepSeek Harness 事件流错误: ' + JSON.stringify(frame.error));
      }
      // 流结束（DSH 重启 / WS 断开）：不抛错，交给并行的轮询兜底。
    } catch (error) {
      rejectEnded(error);
    }
  })();

  const ready = (async () => {
    await opened;
    stream.follow(sessionId);
    // 再用 session.list 把 baseline 钉死（快照事件可能还没到）。
    try {
      const listed = unwrap(await api.callUnary('session.list', {}), 'session.list');
      const item = (listed?.items ?? []).find((row) => row?.sessionId === sessionId);
      const outline = item?.projections?.values?.turnOutline ?? [];
      for (const row of outline) if (Number.isInteger(row?.turn)) baselineTurn = Math.max(baselineTurn, row.turn);
    } catch {
      // 读不到就退回"只看快照里的 turn/start"，不致命。
    }
    // 留一点时间让 follow 的开场快照把历史 turn/start 收进来。
    await new Promise((resolve) => setTimeout(resolve, 60));
    baselineFrozen = true;   // 从这里起，turn/start 属于本轮，不再抬 baseline
    debug('ready', { sessionId, baselineTurn, targetTurn });
    return baselineTurn;
  })();

  return {
    /** 订阅就绪：调用方**在此之后**才发送 prompt。 */
    ready,
    /** 等待本轮回合结束：事件优先，并行轮询兜底。 */
    wait(timeoutMs) {
      const started = Date.now();
      const graceMs = Math.min(3000, Math.max(600, Math.floor(timeoutMs / 8)));
      let settled = false;
      const cancelled = () => settled;
      return Promise.race([
        ended,
        pollTurnResult(api, sessionId, () => baselineTurn, timeoutMs, graceMs, cancelled),
      ])
        .finally(() => { settled = true; })
        .then((result) => ({ ...result, elapsedMs: Date.now() - started }))
        .finally(() => abort.abort());
    },
    close() { abort.abort(); },
  };
}

/**
 * 轮询兜底：从 session/list 投影的 turnOutline 里取本轮结果。
 * turnOutline 每项形如 { turn, seq, prompt, response }，回合结束后 response 即最终文本；
 * 只接受 turn > baselineTurn 的项，避免把历史回合当成新结果。
 */
async function pollTurnResult(api, sessionId, baselineTurnRef, timeoutMs, graceMs, cancelled = () => false) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const deadline = Date.now() + timeoutMs;
  debug('poll start', { sessionId, graceMs, timeoutMs });
  await sleep(Math.max(0, Math.min(graceMs, timeoutMs)));
  while (Date.now() < deadline) {
    if (cancelled()) { debug('poll cancelled (结果已由事件路径拿到)'); return new Promise(() => {}); }
    try {
      const listed = unwrap(await api.callUnary('session.list', {}), 'session.list');
      const item = (listed?.items ?? []).find((row) => row?.sessionId === sessionId);
      const outline = item?.projections?.values?.turnOutline ?? [];
      const baselineTurn = baselineTurnRef();
      const hit = [...outline].reverse().find((row) => Number.isInteger(row?.turn) && row.turn > baselineTurn && typeof row.response === 'string' && row.response.length > 0);
      if (hit) { debug('poll hit', { turn: hit.turn, text: hit.response.slice(0, 80) }); return { turn: hit.turn, reason: 'completed', text: hit.response, source: 'poll' }; }
    } catch (error) {
      // 单次轮询失败（会话刚被归档等）不致命，继续到 deadline。
      debug('poll error', String(error?.message ?? error).slice(0, 160));
    }
    await sleep(600);
  }
  debug('poll timeout', { sessionId, baselineTurn: baselineTurnRef() });
  throw new Error(`等待 DeepSeek Harness 回复超时（${timeoutMs}ms）；会话可能已完成，请用 deepseek_list_sessions 取回结果。`);
}

const server = new McpServer({ name: 'deepseek-harness', version: '0.1.0' });

server.tool(
  'deepseek_status',
  '检查本机 DeepSeek Harness DSH Web API 是否可达，并返回基础状态。',
  {},
  async () => {
    try {
      const settings = await call('settings.describe', {}, 'settings.describe');
      return jsonText({
        ok: true,
        baseUrl: baseUrl(),
        namespaces: Object.keys(settings?.namespaces ?? settings ?? {}).slice(0, 50),
      });
    } catch (error) {
      return errorText(error);
    }
  }
);

server.tool(
  'deepseek_list_presets',
  '列出 DeepSeek Harness 当前可用的 agent presets。',
  {},
  async () => {
    try {
      const presets = await call('agentPresets.list', {}, 'agentPresets.list');
      return jsonText({ ok: true, baseUrl: baseUrl(), ...presets });
    } catch (error) {
      return errorText(error);
    }
  }
);

server.tool(
  'deepseek_list_sessions',
  '列出 DeepSeek Harness 当前会话。',
  {},
  async () => {
    try {
      const sessions = await call('session.list', {}, 'session.list');
      return jsonText({ ok: true, baseUrl: baseUrl(), ...sessions });
    } catch (error) {
      return errorText(error);
    }
  }
);

server.tool(
  'deepseek_create_session',
  '在 DeepSeek Harness 中创建一个会话。默认使用系统临时目录作为 cwd，不碰当前项目文件。',
  {
    cwd: z.string().optional().describe('会话工作目录。默认使用系统临时目录。'),
    agentPreset: z.string().optional().describe('可选 agent preset，例如 standard、minimal、cordis、qq-chat-v2。'),
  },
  async ({ cwd, agentPreset }) => {
    try {
      const request = { cwd: cwd || tempWorkspaceDir() };
      if (agentPreset) request.agentPreset = agentPreset;
      const created = await call('session.create', request, 'session.create');
      return jsonText({ ok: true, baseUrl: baseUrl(), request, ...created });
    } catch (error) {
      return errorText(error);
    }
  }
);

server.tool(
  'deepseek_send_prompt',
  '向 DeepSeek Harness 指定会话发送 prompt。可选择等待本轮回复。',
  {
    sessionId: z.string().describe('DeepSeek Harness sessionId。'),
    prompt: z.string().min(1).describe('要发送给 DeepSeek Harness 的文本。'),
    waitForResult: z.boolean().optional().describe('是否等待本轮回复并返回文本。默认 false。'),
    timeoutMs: z.number().int().positive().max(600_000).optional().describe('等待回复超时，默认 120000。'),
  },
  async ({ sessionId, prompt, waitForResult = false, timeoutMs = DEFAULT_TIMEOUT_MS }) => {
    const api = client();
    let waiter = null;
    try {
      // 顺序很关键：先订阅并等 ready，再发 prompt（否则回合事件可能在订阅生效前就发走）。
      if (waitForResult) {
        waiter = openTurnWaiter(api, sessionId);
        await Promise.race([
          waiter.ready,
          new Promise((_, reject) => setTimeout(() => reject(new Error(`订阅会话事件流超时（${timeoutMs}ms）`)), timeoutMs)),
        ]);
      }
      const accepted = unwrap(await api.callUnary('session.prompt', {
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: prompt }],
      }), 'session.prompt');
      if (!waiter) return jsonText({ ok: true, baseUrl: baseUrl(), accepted });
      const result = await waiter.wait(timeoutMs);
      return jsonText({ ok: true, baseUrl: baseUrl(), accepted, result });
    } catch (error) {
      return errorText(error);
    } finally {
      waiter?.close();
    }
  }
);

server.tool(
  'deepseek_archive_session',
  '归档一个 DeepSeek Harness 会话。',
  {
    sessionId: z.string().describe('要归档的 DeepSeek Harness sessionId。'),
  },
  async ({ sessionId }) => {
    try {
      const archived = await call('workspace.archiveSession', { sessionId }, 'workspace.archiveSession');
      return jsonText({ ok: true, baseUrl: baseUrl(), sessionId, archived });
    } catch (error) {
      return errorText(error);
    }
  }
);

await server.connect(new StdioServerTransport());
