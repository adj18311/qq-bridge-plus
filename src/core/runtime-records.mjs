/**
 * 反馈（feedback.json）与工具调用日志（tool-calls.jsonl）的持久化层。
 *
 * 机械抽取自 bridge.js（冻结快照 .agent-teams/node3-20261020/bridge.start.js，
 * 约 11901-11961 行的 readFeedbackEntries / appendFeedbackEntry / readToolLog /
 * appendToolLog 和 appendToolLogFile 初始化；clear 两段来自 7710-7728 端点表达式）。
 * 四个函数体逐字复制，只把模块级常量换成工厂别名：
 *   feedbackFile → FEEDBACK_FILE、toolLogFile → TOOL_LOG_FILE；
 * 其余依赖（readJsonSafe / atomicWriteJson / createCappedLogger / redactSensitiveText /
 * redactSensitive / log）全部由调用方注入，不在这里重新实现。
 *
 * 刻意保留的旧语义 / 历史怪癖（不要“顺手修”）：
 *  · 反馈上限 500 条，超限从头部 splice；message 只在字符串时脱敏，且经 getter 读三次
 *    （对象展开一次、typeof 一次、取值一次）；
 *  · 反馈读盘不是数组就返回 []，写盘失败原样抛出（控制台端点因此 500）；
 *  · JSONL 先按**原始非空行**切片（默认 200、最少 1、最多 1000）再逐行 parse，坏行只是被
 *    跳过、不参与“有效行”计数；读盘失败返回 []；
 *  · appendToolLog 先复制 entry、再脱敏 error，最后对字符串 args 最多做 4 次 JSON.parse；
 *    写日志的异常全部吞掉，只 log 一条「写入工具调用日志失败:」；
 *  · clearToolLog 直接截断文件、异常吞掉，且**不重置** createCappedLogger 的内存行数计数器
 *    （旧端点的行为；清空后计数器继续累加，轮转仍按剩余额度发生）。
 *
 * 边界：工厂仅在构造时调用一次 createCappedLogger(file, 2000)；路径必须显式传入，
 * 不做默认值或根目录探测，import 时零 I/O。冻结基线见
 * scripts/fixtures/runtime-records-baseline.mjs，改动前先跑 scripts/test-runtime-records.mjs。
 */
import fs from 'node:fs';

/**
 * @param {object} options
 * @param {string} options.feedbackFile 反馈 JSON 文件（显式路径，必填）。
 * @param {string} options.toolLogFile JSONL 工具日志文件（显式路径，必填）。
 * @param {(file: string, fallback: any) => any} options.readJsonSafe
 * @param {(file: string, value: any) => void} options.atomicWriteJson
 * @param {(file: string, maxLines: number) => (text: string) => void} options.createCappedLogger
 * @param {(text: string) => string} options.redactSensitiveText
 * @param {(value: any) => any} options.redactSensitive
 * @param {(...args: any[]) => void} options.log
 */
export function createRuntimeRecordStore({ feedbackFile, toolLogFile, readJsonSafe, atomicWriteJson, createCappedLogger, redactSensitiveText, redactSensitive, log }) {
  const FEEDBACK_FILE = feedbackFile;
  const TOOL_LOG_FILE = toolLogFile;

  function readFeedbackEntries() {
    const data = readJsonSafe(FEEDBACK_FILE, []);
    return Array.isArray(data) ? data : [];
  }

  function appendFeedbackEntry(entry) {
    const safeEntry = {
      ...entry,
      ...(typeof entry?.message === 'string' ? { message: redactSensitiveText(entry.message) } : {})
    };
    const list = readFeedbackEntries();
    list.push(safeEntry);
    if (list.length > 500) list.splice(0, list.length - 500);
    atomicWriteJson(FEEDBACK_FILE, list);
  }

  function readToolLog(limit = 200) {
    try {
      const raw = fs.readFileSync(TOOL_LOG_FILE, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      const parsed = [];
      for (const line of lines.slice(-Math.max(1, Math.min(1000, Number(limit) || 200)))) {
        try { parsed.push(JSON.parse(line)); } catch {}
      }
      return parsed;
    } catch {
      return [];
    }
  }

  const appendToolLogFile = createCappedLogger(TOOL_LOG_FILE, 2000);

  function appendToolLog(entry) {
    try {
      const safeEntry = { ...entry };
      if (typeof safeEntry.error === 'string') safeEntry.error = redactSensitiveText(safeEntry.error);
      if (typeof safeEntry.args === 'string') {
        let parsed = safeEntry.args;
        let parsedOk = false;
        for (let i = 0; i < 4; i++) {
          try {
            const next = JSON.parse(parsed);
            parsed = next;
            parsedOk = true;
            if (typeof next !== 'string') break;
          } catch {
            break;
          }
        }
        if (parsedOk) {
          safeEntry.args = JSON.stringify(redactSensitive(parsed));
        } else {
          safeEntry.args = redactSensitiveText(safeEntry.args);
        }
      }
      // 用内存计数上限的追加器：不再「append 完再读回整个文件数行数」——
      // 那个写法在 2000 行（约 650KB）时单次要 15ms，而每次工具调用要写两条。
      appendToolLogFile(`${JSON.stringify(safeEntry)}\n`);
    } catch (error) {
      log('写入工具调用日志失败:', error?.message ?? error);
    }
  }

  // 对应旧端点 7710-7728：反馈清空走原子写（失败照旧抛给端点）；
  // 工具日志清空直接截断文件，任何 fs 异常都吞掉；两者都不重建 appendToolLogFile。
  function clearFeedbackEntries() {
    atomicWriteJson(FEEDBACK_FILE, []);
  }

  function clearToolLog() {
    try { fs.writeFileSync(TOOL_LOG_FILE, '', 'utf8'); } catch {}
  }

  return {
    readFeedbackEntries,
    appendFeedbackEntry,
    readToolLog,
    appendToolLog,
    clearFeedbackEntries,
    clearToolLog,
  };
}
