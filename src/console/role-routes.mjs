/**
 * 控制台「人格管理」六条路由。
 *
 * 这是从 bridge.js 原样移出的六个处理块（GET /api/roles、GET /api/roles/content；
 * POST /api/roles/create、update、rename、delete）。唯一的语义改动是把对可变全局
 * `roleInjectMaxChars` 的直接读取换成每次调用 `getInjectMaxChars()`；其余校验、
 * 文件顺序、错误文案、响应字段与类型、日志文案都保持原样。
 *
 * 边界：
 *  · 不拥有 /api/roles/limit、/api/role、/api/role-mode、鉴权或模式/预设逻辑；
 *  · `matches()` 是同步纯函数，只精确匹配上面六对 method/path，不做正则、大小写
 *    归一化或任何兜底匹配；未知路由的 `handle()` 直接返回 false，不读 body、
 *    不调用 roleStore、不做 I/O；
 *  · roleStore 由调用方创建并注入，本模块不复制持久化规则，也不在工厂期读目录。
 */
import fs from 'node:fs';
import { ROLE_CONTENT_MAX_BYTES, ROLE_NAME_MAX } from '../core/role-store.mjs';
import { roleCharStats, roleSectionReport } from '../role-card.js';

// 精确到 method + pathname；/api/roles/limit 故意不在其中（仍由桥接自己处理）。
const ROLE_ROUTES = new Set([
  'GET /api/roles',
  'GET /api/roles/content',
  'POST /api/roles/create',
  'POST /api/roles/update',
  'POST /api/roles/rename',
  'POST /api/roles/delete',
]);

/**
 * @param {object} deps
 * @param {object} deps.roles createRoleStore() 返回的仓库对象（原样注入）
 * @param {() => {role: string|null, mode: string}} deps.readRoleState
 * @param {(role: string|null, mode: string) => void} deps.writeRoleState
 * @param {() => number} deps.getInjectMaxChars 每次响应时读取当前注入上限
 * @param {(message: string) => void} deps.log
 */
export function createRoleRoutes({ roles, readRoleState, writeRoleState, getInjectMaxChars, log }) {
  // 只解构一次：后续处理块都调用捕获到的这些引用，行为与桥接原先从同一仓库解构一致。
  const {
    roleFilePath,
    roleWarnings,
    roleSummaries,
    validateRoleName,
    validateRoleContent,
    readRoleContent,
    writeRoleContent,
  } = roles;

  function matches(method, pathname) {
    return ROLE_ROUTES.has(`${method} ${pathname}`);
  }

  async function handle(req, url, { readBody, sendJson }) {
    // 未知/非人格路由：同步返回 false，绝不读 body 或触碰仓库。
    if (!matches(req.method, url.pathname)) return false;

    // ── 人格管理 ──────────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/roles') {
      const rs = readRoleState();
      const summaries = roleSummaries();
      sendJson({
        // roles 保持「人格名字符串数组」的既有契约（scripts/test-console.mjs 等调用方依赖它）；
        // 富信息放在 summaries 里，新老调用方互不影响。
        roles: summaries.map((role) => role.name),
        summaries,
        current: rs.role ?? null,
        limits: { nameMax: ROLE_NAME_MAX, contentMaxBytes: ROLE_CONTENT_MAX_BYTES, injectMaxChars: getInjectMaxChars() },
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/roles/content') {
      let name;
      try { name = validateRoleName(url.searchParams.get('name')); } catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
      if (!fs.existsSync(roleFilePath(name))) { sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return; }
      const content = readRoleContent(name);
      sendJson({
        ok: true,
        name,
        content,
        chars: content.length,
        bytes: Buffer.byteLength(content, 'utf8'),
        warnings: roleWarnings(content),
        limits: { injectMaxChars: getInjectMaxChars() },
        stats: roleCharStats(content),
        // 每个小节在各模式下是否会被注入，供控制台预览「这条规则到底生不生效」
        sections: { v1: roleSectionReport(content, 'v1'), v2: roleSectionReport(content, 'v2') },
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/roles/create') {
      const body = await readBody();
      let name; let content;
      try { name = validateRoleName(body.name); content = validateRoleContent(body.content); }
      catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
      if (fs.existsSync(roleFilePath(name))) { sendJson({ ok: false, error: `人格「${name}」已存在` }, 400); return; }
      writeRoleContent(name, content);
      log(`控制台：创建人格「${name}」（${content.length} 字符）`);
      sendJson({ ok: true, role: name, warnings: roleWarnings(content) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/roles/update') {
      const body = await readBody();
      let name; let content;
      try { name = validateRoleName(body.name); content = validateRoleContent(body.content); }
      catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
      if (!fs.existsSync(roleFilePath(name))) { sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return; }
      writeRoleContent(name, content);
      log(`控制台：更新人格「${name}」（${content.length} 字符）`);
      sendJson({ ok: true, role: name, chars: content.length, warnings: roleWarnings(content) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/roles/rename') {
      const body = await readBody();
      let from; let to;
      try { from = validateRoleName(body.from); to = validateRoleName(body.to); }
      catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
      if (from === to) { sendJson({ ok: true, role: to, renamed: false }); return; }
      if (!fs.existsSync(roleFilePath(from))) { sendJson({ ok: false, error: `人格「${from}」不存在` }, 404); return; }
      if (fs.existsSync(roleFilePath(to))) { sendJson({ ok: false, error: `人格「${to}」已存在` }, 400); return; }
      fs.renameSync(roleFilePath(from), roleFilePath(to));
      const rs = readRoleState();
      const switched = rs.role === from;
      if (switched) writeRoleState(to, rs.mode);
      log(`控制台：人格重命名「${from}」→「${to}」${switched ? '（当前启用中，已跟随切换）' : ''}`);
      sendJson({ ok: true, role: to, renamed: true, currentFollowed: switched });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/roles/delete') {
      const body = await readBody();
      let name;
      try { name = validateRoleName(body.name); } catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
      if (!fs.existsSync(roleFilePath(name))) { sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return; }
      fs.rmSync(roleFilePath(name));
      const rs = readRoleState();
      const cleared = rs.role === name;
      if (cleared) writeRoleState(null, rs.mode);
      log(`控制台：删除人格「${name}」${cleared ? '（该人格正在启用，已同时清除当前人格）' : ''}`);
      sendJson({ ok: true, deleted: name, clearedCurrent: cleared });
      return;
    }

    return false;
  }

  return { matches, handle };
}
