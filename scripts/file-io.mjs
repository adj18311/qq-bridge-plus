// 安全写文件：覆盖前打时间戳备份，写入走「临时文件 + rename」原子替换。
//
// 单独成模块是因为 profile 的 cordis.patch.yml 有两处写入路径：
//   · scripts/setup-dsh.mjs 的 MCP 同步；
//   · scripts/dsh-021-team-patch.mjs 的 0.2.1 Team 片段部署。
// 备份/原子替换的口径必须一致，不能一边保留最近 N 份、另一边无限堆积。
import fs from 'node:fs';
import path from 'node:path';

/**
 * 备份一个即将被覆盖的文件，返回备份路径（文件不存在时返回 null）。
 *
 * 为什么不用 `flag: 'wx'`（写一次就永不更新）：那样第一次安装会留下一个备份，
 * 之后每次写都静默跳过 —— 用户后来手工改过的内容再被覆盖时，桌上那份备份
 * 早已过期，等于「有备份但救不回来」。改为每次覆盖前打时间戳快照，只保留最近 N 份。
 */
export function backupBeforeOverwrite(file, { keep = 5, log = () => {} } = {}) {
  if (!fs.existsSync(file)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${file}.bak-${stamp}`;
  try {
    fs.copyFileSync(file, dest);
  } catch (error) {
    log(`⚠️ 备份失败（${file}）：${error?.message ?? error}；继续但请自行确认原内容`);
    return null;
  }
  try {
    const dir = path.dirname(file);
    const prefix = `${path.basename(file)}.bak-`;
    const snaps = fs.readdirSync(dir).filter((f) => f.startsWith(prefix)).sort();
    // 时间戳升序 ⇒ 前面的是最旧的，只保留最后 keep 份
    for (const f of snaps.slice(0, Math.max(0, snaps.length - keep))) {
      fs.rmSync(path.join(dir, f), { force: true });
    }
  } catch { /* 清理旧备份失败不影响本次写入 */ }
  return dest;
}

/** 先写同目录临时文件再 rename，避免进程中断留下半截 YAML。 */
export function writeFileAtomic(file, text) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, text, 'utf8');
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
