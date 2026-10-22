// reserved2 提示词与插件边界的静态契约；不调用模型，不向 QQ 发送消息。
// 这些检查只能防止关键协议/能力被误删，不能证明聊天质量无损。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import yaml from 'js-yaml';

const preset = yaml.load(fs.readFileSync(
  new URL('../dsh/agent-presets/qq-chat-v2/agent.cordis.yml', import.meta.url), 'utf8',
));
const persona = preset.find((row) => row.id === 'persona');
const prefix = persona?.config?.prefix ?? '';

test('reserved2 YAML resolves to the expected persona and template variables', () => {
  assert.equal(persona?.name, '@deepseek-ai/dsh-persona');
  assert.match(prefix, /\{\{model\}\}/);
  assert.equal(persona.config.suffix, '', '0.2.1 no longer registers the cwd template variable');
  assert.equal(Object.hasOwn(persona.config, 'text'), false);
});

test('local/admin tool restrictions and existing compaction budgets stay intact', () => {
  assert.deepEqual(preset.map((row) => row.id), [
    'persona', 'tool-web', 'tool-ask-user', 'tool-todo', 'qq-tool-restrict', 'compaction',
  ]);
  assert.deepEqual(preset.find((row) => row.id === 'tool-web').config, { search: false, fetch: false });
  assert.equal(preset.find((row) => row.id === 'qq-tool-restrict').name, './qq-tool-restrict.mjs');
  const compaction = preset.find((row) => row.id === 'compaction');
  assert.deepEqual(compaction.isolate, { compaction: true, toolResultPruner: true });
  assert.deepEqual(compaction.config.find((row) => row.id === 'tool-result-pruner').config, {
    thresholdChars: 50000, headChars: 45000, tailChars: 2000,
  });
  for (const text of ['你没有本地工具', '群友没有管理权限', 'API 令牌', '角色由桥接注入']) {
    assert.ok(prefix.includes(text), `missing safety rule: ${text}`);
  }
});

test('snapshots are optional, partial snapshots require reading, and watermarks are not message IDs', () => {
  assert.match(prefix, /可能附带【本次消息快照】/);
  assert.match(prefix, /partial=true[^。]*继续读取/);
  assert.match(prefix, /readThroughSeq 是桥接本地的 seq，不是 QQ messageId/);
  assert.match(prefix, /没有水位[^。]*省略 throughSeq/);
  assert.match(prefix, /首次进入会话、角色变化[^。]*qq_get_prompt/);
});

test('one closing action can acknowledge the read watermark after the full observation', () => {
  assert.match(prefix, /qq_mark_read\(throughSeq=/);
  assert.match(prefix, /qq_set_wake_config\(config=[^)]*throughSeq=/);
  assert.match(prefix, /不需先 mark_read/);
  assert.match(prefix, /qq_wait_for_messages\(timeoutMs=300000\)/);
  assert.match(prefix, /短等待不能代替/);
  assert.match(prefix, /preSleepWaitRemainingMs[^。]*继续等待/);
  assert.match(prefix, /若你参与回复[^。]*重新观察/);
});

test('pre-reply quiet checks, waiting for replies and pre-sleep observation have distinct instructions', () => {
  assert.match(prefix, /先理解并处理当前消息/);
  assert.match(prefix, /【首答前】[^\n]*qq_wait_for_messages\(purpose="reply"\)/);
  assert.match(prefix, /群聊静默只有 3 秒/);
  assert.match(prefix, /从第一条新消息到达起最多再等 6 秒（固定上限，后续消息不延长）/);
  assert.match(prefix, /新消息不再延长 6 秒上限/);
  assert.match(prefix, /私聊沿用推荐旧配置（通常 10~12 秒）/);
  assert.match(prefix, /按最后来信计时，读取和思考花掉的时间也算/);
  assert.match(prefix, /quiet=false[^。]*不代表对方已经说完/);
  assert.match(prefix, /不要机械重开等待/);
  assert.match(prefix, /【等下文】[^\n]*purpose="messages", timeoutMs=60000~120000/);
  assert.match(prefix, /【回复后】[^\n]*qq_wait_for_messages\(purpose="messages"\)/);
  assert.match(prefix, /短静默不算沉睡前观察/);
  assert.match(prefix, /5 分钟观察不是回复的前置条件/);
  assert.match(prefix, /只有准备收尾时[^。]*preSleepWaitRemainingMs/);
});

test('social autonomy and visual, forwarding, sticker and web capabilities remain described', () => {
  for (const text of [
    '【反 AI 味：拒绝有求必应】', '【保持主体性】', '【学习群友策略】',
    '【不要当群管家/主持人】', '普通对话默认 1 条，最多 2 条', '不要用空格断句',
    '不会自动发送到 QQ', 'qq_get_message_images', 'qq_get_forward_msg', 'nestedForwardIds',
    'qq_send_poke', 'qq_list_stickers', 'qq_get_sticker_image', 'qq_send_sticker',
    'qq_collect_sticker', 'qq_sticker_note', 'qq_get_self_image',
    'qq_set_sticker_remark', '只有管理端明确开启后才能用',
    'qq_list_voices', 'qq_send_voice', 'verified=true 才代表这条语音确实落地',
    '语音**默认是关闭的**', '不要假装发了语音',
    'mcp__web-search-safe__web_search', 'mcp__web-search-safe__web_fetch',
  ]) assert.ok(prefix.includes(text), `missing capability or voice rule: ${text}`);
});

test('autonomy limits and the observation escape hatch stay described', () => {
  // These rules were previously unguarded: deleting any of them left every test green.
  for (const text of [
    // 沉睡前观察唯一的逃生口：明确结束语可以跳过 5 分钟等待。
    '除非对方明确“不聊了/晚安/下了/拜拜”等结束语',
    // [SILENT] 是桥接的退出标记，误用会静默吞掉回复。
    '不要用 [SILENT]',
    // 记忆面
    '【记忆卫生】', 'qq_memory_append', 'qq_memory_query', 'qq_memory_remove', 'qq_memory_clear',
    // 黑话面
    'qq_slang_query', 'qq_slang_submit', '不重复提交',
    // 频率上限
    '普通闲聊约 3~5 轮一张', '别刷屏', '每条只能一张，不能附带文字', '不要频繁拍',
    // 会话令牌是硬前置，漏传会被拒绝。
    '作为 token 参数传入',
    // 指定成员唤醒
    'triggers.speakerIds', '不凭记忆乱填',
  ]) assert.ok(prefix.includes(text), `missing rule: ${text}`);
});

test('only privacy and gore stay out of groups; tone and profanity belong to the persona', () => {
  // 口径（用户确认）：只有「他人隐私」和「暴力内容」两类不能往群里搬；
  // 涉政/色情/人身攻击/骂脏话/互怼都允许，且不许用"人身攻击"当拒绝理由 —— 旧版把
  // 人身攻击列进禁止项、又挂着"严重违规"，模型据此静默丢掉人设。
  assert.ok(prefix.includes('【哪些内容不能发到群里】'), 'missing sensitive-content rule section');
  assert.match(prefix, /他人隐私：手机号、住址、身份证、真实姓名、聊天截图、群友照片等/);
  assert.match(prefix, /暴力内容：血腥、虐待、自伤的真实照片与细节描写/);
  assert.match(prefix, /除以上两类，其它内容不受本节限制/);
  assert.match(prefix, /本节不设“其它敏感内容”这类开放式兜底/, 'open-ended catch-all must stay explicitly forbidden');
  assert.match(prefix, /说话方式不归本节管/);
  assert.match(prefix, /骂脏话、互怼、损人、人身攻击属于群内互动，按人设执行/);
  assert.match(prefix, /不要在群里转述或发图/);
  assert.match(prefix, /只在私聊里[^。]*简短说一句/, 'must allow telling the owner in private only');
  for (const stale of [
    '【敏感或不合适的内容怎么处理】',
    '拿不准尺度时，一律按',
    '不要在群里讨论“这条内容敏感”本身',
    '（涉政、色情、暴力、人身攻击、他人隐私等）',
    '未成年人',
  ]) assert.equal(prefix.includes(stale), false, `旧口径必须删掉：${stale}`);
});

test('the send/admin hard-rules section is scoped to sending tools and admin rights only', () => {
  assert.ok(prefix.includes('【发送工具与管理权限的硬规则】'), 'missing scoped hard-rules section');
  assert.match(prefix, /本节只管两件事：\*\*发送工具的用法\*\*/);
  assert.match(prefix, /不管说话方式与语气/);
  // 段内原有条目必须保留，且旧的全覆盖标题不许回来。
  assert.equal(prefix.includes('【发送与汇报禁令（违反即严重违规）】'), false, '旧标题会覆盖语气层，必须删掉');
  for (const text of [
    '不要输出“我已在群里回复了……”',
    '不要重复描述“我发了”“我刚说了”',
    '不要自言自语式地复述你做过的事',
  ]) assert.ok(prefix.includes(text), `missing send/report rule: ${text}`);
});

test('自主逛贴吧：允许想逛就逛，但巡逻的量控/降级约束一条都不能丢', () => {
  // 语义放宽（用户确认）：自发闲逛从"必须聊到才去"改成"想逛就逛"。
  for (const text of [
    '【自主逛贴吧：想逛就逛，不是定时巡逻】',
    '在主动机会里，你可以自己决定去某个吧看看——**想逛就逛**；没有想看的就继续待着，不必勉强。',
    '逛不逛只看你当下的念头',
  ]) assert.ok(prefix.includes(text), `missing self-initiated browsing permission: ${text}`);
  for (const text of ['不要没事就去贴吧溜达', '不要为了刷存在感而逛']) {
    assert.equal(prefix.includes(text), false, `旧的"禁止自发闲逛"措辞必须删掉：${text}`);
  }
  // 放宽措辞不等于放宽边界：这些约束必须原样留在同一段里。
  for (const text of [
    '必须带 reason="patrol"', '并把这次的话题写进 trigger',
    '单次最多读一条帖的前两页', '第 3 页起没有预算',
    '想继续往下读必须先问用户', '那部分不占每日次数',
    '每日自主访问上限 12 次', '静默时段 01:00–08:00 不主动逛',
    'PATROL_DAILY_CAP', 'PATROL_DISABLED', 'PATROL_QUIET_HOURS', '不要重试、不要绕道',
    '被百度安全验证拦住', '不要反复重试',
    'reason="user"', '抓取层节流照样生效',
    '看 ≠ 说', '没有值得说的就安静待着',
    'pendingThought', '用 tid 去重',
  ]) assert.ok(prefix.includes(text), `missing patrol constraint: ${text}`);
});

console.log(`reserved2 persona prefix: ${prefix.length} characters (not a model-token estimate)`);
