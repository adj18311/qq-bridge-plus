// Frozen 2026-10-20 from src/bridge.js (node2 dafc083), lines 4730-4761 and 4775-4825.
// Literal reference copy of the six role-management blocks. Each original `return;`
// stays a return; the surrounding two-space indentation was removed and a factory
// wrapper was added so the blocks can be driven with the same five dependencies.
//
// Sole adaptation: the mutable `roleInjectMaxChars` read became `getInjectMaxChars()`
// (the extracted controller makes the same single adaptation).
//
// This is an independent oracle: it never imports src/console/role-routes.mjs, so
// expectations cannot derive from the module under test. It reuses only the same
// pre-existing role-store constants / role-card helpers the bridge used.
// The `/api/roles/limit` block that sits between the read and write blocks in the
// bridge is intentionally absent: these are exactly the six routes under test.
import fs from 'node:fs';
import { ROLE_CONTENT_MAX_BYTES, ROLE_NAME_MAX } from '../../src/core/role-store.mjs';
import { roleCharStats, roleSectionReport } from '../../src/role-card.js';

const BASELINE_ROUTES = new Set([
  'GET /api/roles',
  'GET /api/roles/content',
  'POST /api/roles/create',
  'POST /api/roles/update',
  'POST /api/roles/rename',
  'POST /api/roles/delete',
]);

export function createBaselineRoleRoutes({ roles, readRoleState, writeRoleState, getInjectMaxChars, log }) {
  const {
    roleFilePath,
    roleWarnings,
    roleSummaries,
    validateRoleName,
    validateRoleContent,
    readRoleContent,
    writeRoleContent,
  } = roles;
  return {
    matches(method, pathname) {
      return BASELINE_ROUTES.has(`${method} ${pathname}`);
    },
    async handle(req, url, { readBody, sendJson }) {
      if (!BASELINE_ROUTES.has(`${req.method} ${url.pathname}`)) return false;

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
    },
  };
}
