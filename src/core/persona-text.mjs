/**
 * 二代仿真模式的纯文本辅助：角色卡「回复示例」空格改写，以及发送内容的中文空格/分条断点软提醒。
 *
 * 机械抽取自 bridge.js（faaa226）里的 cjkLikeChar / convertExampleSpacesToComma /
 * findCjkSpaceWarning / findSplitBoundaryWarning，只改了函数名与内部引用名，函数体逐字保留：
 * 正则与 Set 的构造位置、Array.from / String 强制转换、告警文案、null 返回以及历史怪癖
 * （单侧转换 vs 双侧提醒、UTF-16 长度阈值、字面量标点清单等）都不做“顺手修复”。
 * 冻结基线见 scripts/fixtures/persona-text-baseline.mjs，改动前先跑 scripts/test-persona-text.mjs。
 *
 * 边界：纯函数、零依赖。不读 config、不碰 fs/网络/定时器、不写日志、不发送。
 */

export function cjkLikeChar(ch) {
  if (!ch) return false;
  const code = ch.codePointAt(0);
  return (
    (code >= 0x4E00 && code <= 0x9FFF) ||
    (code >= 0x3400 && code <= 0x4DBF) ||
    (code >= 0xF900 && code <= 0xFAFF) ||
    (code >= 0x3000 && code <= 0x303F)
  );
}

// 仅用于二代角色卡“回复示例”节：把示例里用于分条的中文空格改写成中文逗号。
// 空格两侧只要有一侧是中文/中文标点，且另一侧不是 / \ ( ) [ ] { } " ' < > | 等符号，就转成逗号。
// 这样能保留示例内容，同时避免把英文/URL/斜杠周围的空间改坏。
export function convertExampleSpaces(line) {
  const chars = Array.from(String(line ?? ''));
  const NO_REPLACE = new Set(['/', '\\', '(', ')', '[', ']', '{', '}', '"', "'", '<', '>', '|', '&', '=', ':', ';', ',', '.', '。', '，', '、']);
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === ' ' || ch === '\t') {
      const prev = chars[i - 1];
      const next = chars[i + 1];
      const prevCjk = !!prev && cjkLikeChar(prev);
      const nextCjk = !!next && cjkLikeChar(next);
      const prevBlocked = !!prev && NO_REPLACE.has(prev);
      const nextBlocked = !!next && NO_REPLACE.has(next);
      if ((prevCjk || nextCjk) && !prevBlocked && !nextBlocked) {
        out += '，';
        continue;
      }
    }
    out += ch;
  }
  return out;
}

// 检测二代发送内容里“中文之间用空格”的不自然写法，用于给 AI 返回软提醒。
// 只检测空格两侧都是中文/中文标点的情况，避免误伤英文单词间隔（如 DeepSeek V3）。
export function cjkSpaceWarning(messages) {
  const bad = [];
  for (let i = 0; i < (messages || []).length; i++) {
    const chars = Array.from(String(messages[i] ?? ''));
    for (let j = 0; j < chars.length; j++) {
      const ch = chars[j];
      if (ch !== ' ' && ch !== '\t') continue;
      const prev = chars[j - 1];
      const next = chars[j + 1];
      if (prev && next && cjkLikeChar(prev) && cjkLikeChar(next)) {
        bad.push(i + 1);
        break;
      }
    }
  }
  if (!bad.length) return null;
  const list = [...new Set(bad)];
  const label = list.length === 1 ? `第 ${list[0]} 条` : `第 ${list.join('、')} 条`;
  return `${label}消息内部有中文空格，真人一般不这么打；可删掉空格用标点，或拆成数组多条。`;
}

// 检测二代发送内容里“分条断点不自然”的情况：某条消息以逗号/顿号等非终止标点结尾，
// 或以“的/了/吗/呢/吧/是/在/把/被/让/给”等通常需要接后续成分的词结尾，下一条又紧跟中文内容，
// 说明 AI 很可能把同一句话拆到了两条消息里。这里只做软提醒，不拦截、不改写。
export function splitBoundaryWarning(messages) {
  if (!Array.isArray(messages) || messages.length <= 1) return null;
  const INCOMPLETE_TAIL_RE = /(?:的|了|吗|呢|吧|啊|呀|嘛|是|在|把|被|让|给|从|对|向|和|与|或|而|但|然|就|都|还|又|也|很|太|最|更|不|没|有|这|那|哪|啥|什么|怎么|为什么|因为|所以|但是|然后|我|你|他|她|它)$/;
  // 这些是常见“短句但完整”的结尾，不应因为以“的/了”等结尾就被当成半句话。
  const COMPLETE_SHORT = new Set(['好的', '行了', '算了', '知道了', '可以了', '没事了', '走了', '睡了', '来了', '懂了', '明白了', '抱歉', '没事', '好吧', '行吧', '算了吧', '好', '行', '嗯', '哦']);
  const bad = [];
  for (let i = 0; i < messages.length - 1; i++) {
    const prev = String(messages[i] ?? '').trim();
    const next = String(messages[i + 1] ?? '').trim();
    if (!prev || !next || COMPLETE_SHORT.has(prev)) continue;
    const nextStartsCjk = cjkLikeChar(Array.from(next)[0]);
    const nonTerminalPunct = /[,，、；;:：]$/.test(prev);
    const incompleteTail = nextStartsCjk && prev.length >= 3 && INCOMPLETE_TAIL_RE.test(prev);
    if (nonTerminalPunct || incompleteTail) {
      bad.push(`${i + 1}、${i + 2}`);
    }
  }
  if (!bad.length) return null;
  return `第 ${bad.join('，')} 条之间像是把同一句话拆开了；如果两条拼起来才完整，请合并成一条，或把断点移到完整句子的边界。`;
}
