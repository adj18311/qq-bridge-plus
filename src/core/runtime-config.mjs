/**
 * 运行期配置解析（纯函数）。
 *
 * 边界：
 *  · 本模块不读文件、不探测凭据、不写日志、不装定时器：输入是**已经解析好的**
 *    config.json 对象，输出 `{ config, diagnostics }`；真正的 I/O（readJsonSafe、
 *    discoverDshLaunchToken、log）仍由入口 `src/bridge.js` 负责。
 *  · 默认值 / 深度合并 / 归一化与入口历史上的 `loadConfig()` 逐字一致，
 *    包括 `??`、`=== true`、allow/deny 别名、非对象 spread、socialV2 各节深度合并
 *    以及 reasoningEffort 的三态语义。任何行为变化都必须先改快照对照测试。
 *  · 诊断只以有序数组返回（`{ code, level: 'warn', message }`），message 与入口
 *    原来 `log()` 的字符串逐字节一致，携带顺序也一致（reasoningEffort 先、role 上限后）。
 *  · `ROLE_INJECT_MAX_CHARS_DEFAULT` / `SLANG_RECENT_RESERVE_DEFAULT` 一律从权威模块
 *    导入，绝不在这里复制常量，也绝不 import `src/bridge.js`。
 */

import { ROLE_INJECT_MAX_CHARS_DEFAULT } from './role-store.mjs';
import { SLANG_RECENT_RESERVE_DEFAULT } from '../slang-learner.js';

/**
 * 管理员 QQ（ownerQQ）规范化：空值 = 未设置；必须是正整数 QQ 号。
 * 与入口 normalizeOwnerQQ 完全一致（包括两条错误文案）。
 */
export function normalizeOwnerQQ(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (!/^\d+$/.test(s)) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
  return n;
}

/**
 * 白名单/黑名单值规范化：只接受字符串或数字数组，非数组按空列表处理
 * （fail-closed 语义由调用方决定）。与入口 normalizeIdList 完全一致。
 */
export function normalizeIdList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v).trim()).filter((v) => /^\d+$/.test(v));
}

/**
 * 人格注入上限的数值校正：非有限值回默认，否则四舍五入并夹在 1000~20000。
 * 与入口 applyRoleInjectLimit 完全一致；本函数不读写任何模块级状态。
 */
export function applyRoleInjectLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return ROLE_INJECT_MAX_CHARS_DEFAULT;
  return Math.min(20000, Math.max(1000, Math.round(n)));
}

// 与入口 loadConfig() 里 log() 的原文逐字一致。
const REASONING_EFFORT_NOT_STRING_MESSAGE =
  '⚠️ config.json 的 dsh.reasoningEffort 不是字符串，已按「未设置」处理（selectModel 将省略该字段）';

/**
 * 解析运行期配置。
 *
 * @param {object} file 已通过 JSON.parse 得到的 config.json 对象。
 * @param {string} [configPath] 仅用于顶层格式错误的文案；默认 'config.json'。
 * @returns {{ config: object, diagnostics: Array<{code: string, level: 'warn', message: string}> }}
 */
export function parseRuntimeConfig(file, configPath = 'config.json') {
  if (!file || typeof file !== 'object' || Array.isArray(file)) {
    throw new Error(`配置格式错误：${configPath}`);
  }

  const diagnostics = [];
  const addWarning = (code, message) => {
    diagnostics.push({ code, level: 'warn', message });
  };

  const cfg = {
    dsh: {
      baseUrl: 'http://127.0.0.1:3080',
      provider: 'deepseek-official',
      // 多模态模型：DeepSeek-V41-Flash（DSH 模型目录里 inputModalities 含 image）。
      // 旧默认 deepseek-v4-flash-vision-exp 已被取代；config.json 未配置时用此兜底。
      model: 'deepseek-flash',
      reasoningEffort: 'max',
      // 兼容新版 DSH 的 API 鉴权：如果 DSH 升级后要求非浏览器客户端带 token，
      // 在这里配置 token；默认走 Authorization: Bearer <token>。
      authToken: '',
      authHeader: 'authorization',
      authPrefix: 'Bearer',
      // 是否允许把 DSH launch token 发往非回环地址（默认 false：那是进程启动凭据）
      allowRemote: false,
      ...(file.dsh ?? {})
    },
    snowluma: { wsUrl: 'ws://127.0.0.1:3001', accessToken: '', ...(file.snowluma ?? {}) },
    // 空 => 每个会话在 state/agents/<key> 下建独立工作目录
    sessionCwd: file.sessionCwd ?? '',
    agentPreset: file.agentPreset ?? 'qq-chat',
    workspaceTitle: file.workspaceTitle ?? 'QQ 聊天',
    ownerQQ: normalizeOwnerQQ(file.ownerQQ),
    allow: {
      private: normalizeIdList(file.allow?.private ?? file.allow?.privates ?? []),
      groups: normalizeIdList(file.allow?.groups ?? file.allow?.group ?? [])
    },
    deny: {
      private: normalizeIdList(file.deny?.private ?? file.deny?.privates ?? []),
      groups: normalizeIdList(file.deny?.groups ?? file.deny?.group ?? [])
    },
    // 私聊/群聊均未配置白名单时是否放行所有（true 时启动会打警告）
    allowAllWhenEmpty: file.allowAllWhenEmpty === true,
    ackMessage: file.ackMessage ?? '🤔 收到，正在思考…',
    sendDelayMs: file.sendDelayMs ?? 300,
    questionTimeoutMs: file.questionTimeoutMs ?? 5 * 60 * 1000,
    consolePort: file.consolePort ?? 3100,
    consoleToken: file.consoleToken ?? '',
    // 价目表覆盖项（可选）。留空即用 src/model-prices.js 的官方默认价。
    pricing: file.pricing ?? null,
    security: {
      interceptNotify: true,
      ...(file.security ?? {})
    },
    slang: {
      enabled: true,
      extractMinMessages: 10,
      extractCooldownMs: 5 * 60 * 1000,
      inferenceThresholds: [2, 4, 8],
      injectMax: 8,
      // t35：给「最近确认/编辑」的词条留的保底名额（新确认的词 count=0，按 count 排序永远挤不进清单）
      recentReserve: SLANG_RECENT_RESERVE_DEFAULT,
      learnerPreset: 'qq-chat',
      workspaceTitle: 'QQ 黑话学习',
      autoResearch: true,
      ...(file.slang ?? {})
    },
    social: {
      enabled: true,
      // 启动阶段（观望）
      triggerProbability: 0.1,        // 普通消息触发进入活跃的概率
      contextWindow: 20,              // 触发/活跃回复时附带的上下文条数
      // 活跃阶段（对话进行中）
      activeCheckMinMs: 10 * 1000,    // 活跃期检测间隔范围（当前控制台保存值）
      activeCheckMaxMs: 30 * 1000,
      activeReplyDelayMinMs: 2 * 1000, // 活跃期回复延迟范围（当前控制台保存值）
      activeReplyDelayMaxMs: 8 * 1000,
      // 活跃超时主动退出（防止活跃群中一直保持活跃）
      activeDurationEnabled: true,     // 总开关：是否启用“活跃超过时长后主动收尾退场”
      activeDurationMinMs: 15 * 60 * 1000, // 活跃状态最长持续时间下限（进入活跃那一刻起算，分钟）
      activeDurationMaxMs: 30 * 60 * 1000, // 活跃状态最长持续时间上限（分钟）
      // 冷场处理
      idleWindowMs: 6 * 60 * 1000,    // 活跃期多久没人说话算冷场
      idleRetryProbability: 0.25,     // 冷场时 AI 继续说一句（试探群友意愿）的概率
      idleRetryWaitMs: 2 * 60 * 1000, // 试探后等待回应的窗口，仍无人说话则 100% 回观望
      // 二期：观望阶段主动开话题（第三种触发）
      proactiveEnabled: true,         // 总开关
      proactiveIdleThresholdMs: 30 * 60 * 1000, // 群安静多久才进入可判定状态
      proactiveCheckMinMs: 45 * 60 * 1000,      // 判定间隔范围
      proactiveCheckMaxMs: 90 * 60 * 1000,
      proactiveProbability: 0.2,      // 每次判定的成功概率（小概率开口）
      // 选择性沉默/退让
      skipProbability: 0.15,          // 普通闲聊沉默概率（当前控制台保存值）
      surrenderProbability: 0,        // 已弃用：桥接不再直接生成退让短句（避免割裂），保留字段兼容旧配置
      // 摘要与展示
      maxReplyChars: 500,             // 单条 QQ 消息安全长度上限（防 AI 出 bug；分句交给 AI 用空格控制）
      mustReplyKeywords: ['deepseek', '小鲸鱼', '大肥鱼', '鲸鱼', 'd指导', '在吗'],
      // 真人式多消息分条发送：按空格分句，AI 用空格表示“这里要分成下一条”
      burstEnabled: true,             // 总开关：是否允许按空格拆成多条 QQ 消息
      burstIntervalMinMs: 1000,       // 条间随机间隔下限（毫秒）
      burstIntervalMaxMs: 3000,       // 条间随机间隔上限（毫秒）
      longGapProbability: 0.1,        // 长间隔概率（当前控制台保存值）
      longGapMinMs: 2500,             // 长间隔下限（当前控制台保存值）
      longGapMaxMs: 5000,             // 长间隔上限（当前控制台保存值）
      ...(file.social ?? {})
    },
    socialV2: {
      enabled: true,
      autoReplyCheckMs: 30000,
      agentPreset: 'qq-chat-v2',
      provideRecommendations: true,
      tools: {
        getPrompt: true,
        getUnread: true,
        getRecent: true,
        socialState: true,
        sendGroup: true,
        sendPrivate: true,
        reply: true,
        sendBurst: true,
        sendMessage: true,
        waitMessages: true,
        feedback: true,
        getMyRecent: true,
        getMessageDetail: true,
        getActiveMembers: true,
        setWakeConfig: true,
        markRead: true,
        memory: true,
        getImages: true,
        getForwardMsg: true,
        sendPoke: true,
        listStickers: true,
        getStickerImage: true,
        sendSticker: true,
        setStickerRemark: false,
        stickerNote: true,
        collectSticker: true,
        getSelfImage: true
      },
      wake: {
        defaultMode: 'diving',
        preSleepWaitEnabled: true,      // 沉睡前强制观察窗口开关：防止 AI 聊两句就潜水
        preSleepWaitMs: 300000,          // 默认沉睡前至少等待/观察 5 分钟（后台可调）
        recommendedDefaultInfinite: true, // 默认下一次唤醒是否无限期（true=永久潜水等条件；false=有限时长）
        sleepMinMs: 60000,
        sleepMaxMs: 0,
        recommendedSleepMinMs: 300000,
        recommendedSleepMaxMs: 7200000,
        recommendedProbability: 0.05,
        recommendedKeywords: ['小鲸鱼', 'DeepSeek', 'deepseek', 'DS', 'D老师', 'd老师', 'D指导', 'd指导', 'D师傅', 'd师傅', '深度求索', '大肥鱼', '鲸鱼', 'DeepSeek V3', 'DeepSeek R1', 'R1'],
        recommendedAtMention: true,
        recommendedNameMention: true,
        recommendedQuestion: true,
        recommendedPoke: true,
        recommendedHint: '如果你要潜水，推荐先调用 qq_wait_for_messages(timeoutMs=300000) 完成一次沉睡前观察：5 分钟内没人说话就可以设置下一次唤醒并沉睡；若期间有人发新消息，先查看 newMessages，判断不需要你参与可直接沉睡，若参与了则下次想睡需再等观察窗口。潜水时长推荐 5~120 分钟，普通消息概率 0.05；@/名字/关键词/提问唤醒建议保持开启。需要等特定某人/某几人时，可额外设置 triggers.speakerIds。',
        batchWindowMs: 8000,
        maxWakePerMinute: 1,
        maxWakePerHour: 12,
        noActionLimit: 3,
        maxWakeConfigReminders: 2
      },
      send: {
        burstEnabled: true,
        burstMaxMessages: 8,
        burstIntervalMinMs: 1000,
        burstIntervalMaxMs: 3000,
        longGapProbability: 0.2,
        longGapMinMs: 5000,
        longGapMaxMs: 10000,
        maxSendPerMinute: 8,
        maxSendPerHour: 60,
        maxMessageChars: 500,
        maxGapMs: 10000,
        gapBaseMs: 800,
        gapPerCharMs: 20,
        recommendedHint: '普通闲聊建议一次 1~3 条，条间 1~3 秒；讲故事/回忆可以 5~10 秒间隔；不要连续刷屏。'
      },
      wait: {
        defaultMs: 30000,
        minMs: 5000,
        maxMs: 600000,
        defaultQuietMs: 8000,
        minQuietAfterNewMs: 10000   // 收到新消息后至少再等这么久（默认 10 秒），防止抢话
      },
      sticker: {
        enabled: true,             // 表情包体系总开关
        syncTtlMs: 60000,          // QQ 收藏表情刷新缓存 TTL（毫秒）
        maxListCount: 100,         // qq_list_stickers 单次最大返回数
        includeInPrompt: true,     // 是否在 qq_get_prompt / 唤醒提示里附带表情摘要与策略
        promptMaxStickers: 8,      // 提示里最多列出的常用表情数
        collect: {
          enabled: true,           // AI 收藏他人表情总开关
          maxPerMinute: 2,         // 每分钟最多收藏次数
          maxPerHour: 10,          // 每小时最多收藏次数
          maxRemarkChars: 20       // 收藏时备注最大长度
        }
      },
      proactive: {
        enabled: true,
        checkIntervalMinMs: 30 * 60 * 1000,
        checkIntervalMaxMs: 90 * 60 * 1000,
        idleThresholdMs: 15 * 60 * 1000,
        probability: 0.3
      },
      feedback: {
        maxLength: 500,
        notifyOwnerOnError: false
      },
      context: {
        recentLimit: 100,
        unreadLimit: 30,
        contextWindow: 20,
        inlineWakeMessages: true,
        wakeMessageLimit: 12,
        wakeRecentLimit: 4,
        wakeMaxChars: 6000
      },
      // 贴吧只读抓取的可选登录态：**只存路径**（cookie 值放在那个文件里），默认空 = 不启用。
      tieba: {
        cookieFile: ''
      },
      ...(file.socialV2 ?? {})
    }
  };

  // socialV2.tools 需要与默认值深度合并：旧 config.json 若缺少新增工具开关，
  // 不能因为外层 spread 覆盖而丢失默认开关。
  cfg.socialV2.tools = {
    getPrompt: true,
    getUnread: true,
    getRecent: true,
    socialState: true,
    sendGroup: true,
    sendPrivate: true,
    reply: true,
    sendBurst: true,
    sendMessage: true,
    waitMessages: true,
    feedback: true,
    getMyRecent: true,
    getMessageDetail: true,
    getActiveMembers: true,
    setWakeConfig: true,
    markRead: true,
    memory: true,
    slangQuery: true,
    slangSubmit: true,
    getImages: true,
    getForwardMsg: true,
    sendPoke: true,
    listStickers: true,
    getStickerImage: true,
    sendSticker: true,
    setStickerRemark: false,
    stickerNote: true,
    collectSticker: true,
    getSelfImage: true,
    sendVoice: false,
    // 发图片（qq_send_image）：默认开。它不发自由文本、也不是"开口说话"那种强表达，但有硬护栏
    // ——只能发白名单图床、单张 ≤4MiB、计入发送频率上限（见 sendImageV2）。
    sendImage: true,
    // 自主逛贴吧（qq_tieba_list / qq_tieba_read 的**巡逻**用法）：默认开。关掉它不等于禁用贴吧工具，
    // 而是「只允许用户在会话里明确要求时用」（reason="user"）——AI 自己想起来去看（reason="patrol"）
    // 会被闸门按 PATROL_DISABLED 拒绝。预算/静默时段在 socialV2.patrol 里。
    patrol: true,
    ...(cfg.socialV2.tools ?? {})
  };

  // socialV2.voice：语音发送（把准备好的音频文件当 QQ 语音发出去）。
  // dir 为相对仓库根目录的语音库路径；AI 的 qq_send_voice 默认只能从这个目录取文件，
  // 绝对路径需要显式开 allowAbsolutePath（默认关，避免 prompt injection 读到任意本地文件）。
  //
  // 默认**关闭**（enabled/sendVoice 均为 false）：语音是"开口说话"的强表达，且需要你先准备好
  // 语音库内容。没放音频就让 AI 发语音只会得到一串错误。把音频放进 audio/ 后，
  // 在控制台「二代仿真 → 语音库与语音发送」里打开开关即可。
  cfg.socialV2.voice = {
    enabled: false,
    dir: 'audio',
    maxSeconds: 300,
    maxBytes: 20 * 1024 * 1024,
    maxPerMinute: 2,
    maxPerHour: 10,
    allowAbsolutePath: false,
    // 音量：默认倍数（1 = 原样）+ 智能音量档位 + ffmpeg 位置（空 = 走 PATH）。
    // SnowLuma 的 record 段没有增益字段，所以音量必须在本地先调好再发。
    defaultVolume: 1,
    loudness: 'normal',
    ffmpegPath: '',
    autoReadback: true,
    ...(cfg.socialV2?.voice ?? {})
  };

  // socialV2.sticker.collect 也需要深度合并，避免旧配置缺失 collect 子项时丢默认值。
  cfg.socialV2.sticker = {
    enabled: true,
    syncTtlMs: 60000,
    maxListCount: 100,
    includeInPrompt: true,
    promptMaxStickers: 8,
    collect: {
      enabled: true,
      maxPerMinute: 2,
      maxPerHour: 10,
      maxRemarkChars: 20,
      ...((cfg.socialV2?.sticker?.collect) ?? {})
    },
    ...(cfg.socialV2?.sticker ?? {}),
    collect: {
      enabled: true,
      maxPerMinute: 2,
      maxPerHour: 10,
      maxRemarkChars: 20,
      ...((cfg.socialV2?.sticker?.collect) ?? {})
    }
  };

  // socialV2.tieba：贴吧只读抓取的可选登录态。**只存 cookie 文件的路径**，默认空 = 不启用
  // （cookie 值本身绝不能进 config.json —— 它会进控制台、进备份、进 git status）。
  // 这里深度合并一次，旧配置缺这一节时不会把默认值弄丢。
  cfg.socialV2.tieba = {
    cookieFile: '',
    ...((cfg.socialV2 && typeof cfg.socialV2.tieba === 'object' && !Array.isArray(cfg.socialV2.tieba)) ? cfg.socialV2.tieba : {})
  };

  // socialV2.patrol：**时机驱动**的自主逛贴吧（t79）。它没有定时器——AI 只有在会话里聊到相关
  // 话题时才可能自己想起来去看一眼（见预设里的【自主逛贴吧】段落），这里只是它的预算与边界：
  //   · enabled=false        ⇒ 巡逻访问一律按 PATROL_DISABLED 拒绝（用户明确要求仍可用）；
  //   · dailyVisitCap        ⇒ 每日自主访问上限（1 次 = 抓 1 条帖或抓 1 次吧页列表），自然日重置；
  //   · maxPagesPerThread    ⇒ 巡逻单次读帖最多前几页（想继续读要先在会话里问用户）；
  //   · quietHours=[起,止)   ⇒ 静默时段内巡逻不主动发起（默认 01:00–08:00）。
  // 深度合并一次：旧 config.json 缺这一整节时不会把默认值弄丢（与上面 tieba 同一套写法）。
  //
  // ⚠️ 这里的默认值写成**字面量**（与 `src/tieba-lib.js` 的 `PATROL_DEFAULTS` 逐字一致），
  // 不直接引用那个常量：入口 loadConfig() 是**启动期**就跑的，而本仓库有若干 VM 夹具按需
  // 注入模块绑定；在启动期多要一个绑定，会让这些夹具在 main() 里直接 ReferenceError。
  cfg.socialV2.patrol = {
    enabled: true,
    dailyVisitCap: 12,
    maxPagesPerThread: 2,
    quietHours: [1, 8],
    ...((cfg.socialV2 && typeof cfg.socialV2.patrol === 'object' && !Array.isArray(cfg.socialV2.patrol)) ? cfg.socialV2.patrol : {})
  };

  // DSH 0.1.7 起 launch token 是**每进程现生成的 32 字节随机数，只存在内存里**，
  // 不落盘、不可推导；只有启动器把 `dsh web` 的 stdout 重定向到文件时才能从日志读到。
  // 所以这里发现的 token 只是兜底，主路径是客户端用 ~/.dsh 里持久化的签名密钥
  // 离线铸造会话 Cookie（见 dsh-client 的 mintBrowserSessionCookie）。
  // authTokenExplicit 记录「token 是用户填的还是这里猜的」，客户端据此排优先级。
  // 纯解析模块只记录标志：真正的 discoverDshLaunchToken() 由入口在拿到结果后调用。
  cfg.dsh.authTokenExplicit = Boolean(cfg.dsh.authToken);

  // 思考强度（A③ 修订 / t5）：config.json 里这个字段有三种状态，必须区分，不能再一律
  // 规范化成内置 low/high/max：
  //   · 字段缺失          → 旧行为：桥接默认 max（老配置不改语义）；
  //   · 字段为空字符串 "" → 显式「未设置/留空」：selectModel 省略 reasoningEffort，交给模型自身默认；
  //   · 非空字符串        → 原样保留（可能是目录声明的 medium/xhigh/off…；启动时不能裁成/回退 max）。
  // 为什么不在启动期按目录校验：目录 RPC 是异步的，而 loadConfig 是启动期同步路径；非法/未声明值
  // 由 POST /api/dsh/model 的目录校验拒绝。手工把 config 改成目录未声明的值，最多在该会话
  // selectModel 时由 DSH 报错（不再被桥接静默改写成 max）。
  const storedDsh = file.dsh && typeof file.dsh === 'object' && !Array.isArray(file.dsh) ? file.dsh : null;
  if (storedDsh && Object.prototype.hasOwnProperty.call(storedDsh, 'reasoningEffort')) {
    const raw = storedDsh.reasoningEffort;
    if (raw === null) {
      cfg.dsh.reasoningEffort = '';
    } else if (typeof raw === 'string') {
      cfg.dsh.reasoningEffort = raw.trim();
    } else {
      cfg.dsh.reasoningEffort = '';
      addWarning('reasoning-effort-non-string', REASONING_EFFORT_NOT_STRING_MESSAGE);
    }
  }

  // 人格卡注入上限（字符）。历史硬编码 6000，现在可配：每条约 4~6k token 的成本护栏。
  cfg.role = { maxInjectChars: ROLE_INJECT_MAX_CHARS_DEFAULT, ...(file.role ?? {}) };
  const roleInjectMaxChars = applyRoleInjectLimit(cfg.role.maxInjectChars);
  if (roleInjectMaxChars !== cfg.role.maxInjectChars) {
    addWarning(
      'role-inject-limit-clamped',
      `人格注入上限已按范围校正为 ${roleInjectMaxChars} 字符（配置值 ${cfg.role.maxInjectChars}，允许 1000~20000）`
    );
  }

  return { config: cfg, diagnostics };
}
