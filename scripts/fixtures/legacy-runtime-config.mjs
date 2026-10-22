// 旧 loadConfig 差分基线夹具（仅测试用 / 不可变参照 / 不是第二生产实现）
//
// 来源：.agent-teams/modularization-stage2-20261017/snapshot/bridge.start.js
//       抽取日期 2026-10-17（modularization stage2 把 loadConfig 抽到 src/core/runtime-config.mjs 之前的入口实现）
// 范围：只窄复制 loadConfig / applyRoleInjectLimit / normalizeOwnerQQ / normalizeIdList 四个函数，
//       外加它们真正需要的默认常量与 I/O 桩；不整文件复制，不含任何实际 config 或凭据。
// 冻结常量：ROLE_INJECT_MAX_CHARS_DEFAULT = 6000、SLANG_RECENT_RESERVE_DEFAULT = 5
//           （快照当时的取值，硬编码为本夹具的一部分；禁止 import 当前 src 反推期望值）。
// 纪律：本文件是历史行为的**只读参照**，不是第二生产实现，生产实现以 src/core/runtime-config.mjs 为准；
//       历史快照被删除/改名后，本夹具仍必须独立可用（测试不得再读 .agent-teams）。
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROLE_INJECT_MAX_CHARS_DEFAULT = 6000;
export const SLANG_RECENT_RESERVE_DEFAULT = 5;

export const LEGACY_FIXTURE_PATH = fileURLToPath(import.meta.url);

// 夹具强制存在：差分基线缺失时必须清晰报错，调用方禁止把「缺失」当成「跳过」。
export function assertLegacyFixturePresent(fixturePath = LEGACY_FIXTURE_PATH) {
  if (typeof fixturePath !== 'string' || fixturePath === '' || !fs.existsSync(fixturePath)) {
    throw new Error(
      `旧 loadConfig 差分基线夹具缺失：${fixturePath}；差分基线必须随仓库提交，缺失时测试必须失败而不是跳过`
    );
  }
  return fixturePath;
}

// 每次调用都新建隔离作用域：旧 loadConfig 会写模块级的 roleInjectMaxChars，不能跨用例复用。
// file 对应旧实现里 readJsonSafe(configPath) 的返回值；其余 I/O 全部是桩。
export function createLegacyRuntimeConfig({ file, configPath = 'X/config.json' } = {}) {
  const ROOT = String(configPath).split('/')[0];
  const path = { join: (...parts) => parts.join('/') };
  const messages = [];
  function readJsonSafe() { return file; }
  function discoverDshLaunchToken() { return ''; }
  function log(message) { messages.push(String(message)); }

  let roleInjectMaxChars = ROLE_INJECT_MAX_CHARS_DEFAULT;

  function applyRoleInjectLimit(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return ROLE_INJECT_MAX_CHARS_DEFAULT;
    return Math.min(20000, Math.max(1000, Math.round(n)));
  }

  // 管理员 QQ（ownerQQ）规范化：空值=未设置；必须是正整数 QQ 号。
  function normalizeOwnerQQ(value) {
    if (value === undefined || value === null) return null;
    const s = String(value).trim();
    if (!s) return null;
    if (!/^\d+$/.test(s)) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
    const n = Number(s);
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
    return n;
  }

  // 白名单/黑名单值规范化：只接受字符串或数字数组，非数组按空列表处理。
  function normalizeIdList(value) {
    if (!Array.isArray(value)) return [];
    return value.map((v) => String(v).trim()).filter((v) => /^\d+$/.test(v));
  }

  // ── 配置 ──────────────────────────────────────────────────────────────────
  function loadConfig() {
    const p = path.join(ROOT, 'config.json');
    const file = readJsonSafe(p, null, true);
    if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error(`配置格式错误：${p}`);
    const cfg = {
      dsh: {
        baseUrl: 'http://127.0.0.1:3080',
        provider: 'deepseek-official',
        model: 'deepseek-flash',
        reasoningEffort: 'max',
        authToken: '',
        authHeader: 'authorization',
        authPrefix: 'Bearer',
        allowRemote: false,
        ...(file.dsh ?? {})
      },
      snowluma: { wsUrl: 'ws://127.0.0.1:3001', accessToken: '', ...(file.snowluma ?? {}) },
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
      allowAllWhenEmpty: file.allowAllWhenEmpty === true,
      ackMessage: file.ackMessage ?? '🤔 收到，正在思考…',
      sendDelayMs: file.sendDelayMs ?? 300,
      questionTimeoutMs: file.questionTimeoutMs ?? 5 * 60 * 1000,
      consolePort: file.consolePort ?? 3100,
      consoleToken: file.consoleToken ?? '',
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
        recentReserve: SLANG_RECENT_RESERVE_DEFAULT,
        learnerPreset: 'qq-chat',
        workspaceTitle: 'QQ 黑话学习',
        autoResearch: true,
        ...(file.slang ?? {})
      },
      social: {
        enabled: true,
        triggerProbability: 0.1,
        contextWindow: 20,
        activeCheckMinMs: 10 * 1000,
        activeCheckMaxMs: 30 * 1000,
        activeReplyDelayMinMs: 2 * 1000,
        activeReplyDelayMaxMs: 8 * 1000,
        activeDurationEnabled: true,
        activeDurationMinMs: 15 * 60 * 1000,
        activeDurationMaxMs: 30 * 60 * 1000,
        idleWindowMs: 6 * 60 * 1000,
        idleRetryProbability: 0.25,
        idleRetryWaitMs: 2 * 60 * 1000,
        proactiveEnabled: true,
        proactiveIdleThresholdMs: 30 * 60 * 1000,
        proactiveCheckMinMs: 45 * 60 * 1000,
        proactiveCheckMaxMs: 90 * 60 * 1000,
        proactiveProbability: 0.2,
        skipProbability: 0.15,
        surrenderProbability: 0,
        maxReplyChars: 500,
        mustReplyKeywords: ['deepseek', '小鲸鱼', '大肥鱼', '鲸鱼', 'd指导', '在吗'],
        burstEnabled: true,
        burstIntervalMinMs: 1000,
        burstIntervalMaxMs: 3000,
        longGapProbability: 0.1,
        longGapMinMs: 2500,
        longGapMaxMs: 5000,
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
          preSleepWaitEnabled: true,
          preSleepWaitMs: 300000,
          recommendedDefaultInfinite: true,
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
          minQuietAfterNewMs: 10000
        },
        sticker: {
          enabled: true,
          syncTtlMs: 60000,
          maxListCount: 100,
          includeInPrompt: true,
          promptMaxStickers: 8,
          collect: {
            enabled: true,
            maxPerMinute: 2,
            maxPerHour: 10,
            maxRemarkChars: 20
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
        tieba: {
          cookieFile: ''
        },
        ...(file.socialV2 ?? {})
      }
    };

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
      sendImage: true,
      patrol: true,
      ...(cfg.socialV2.tools ?? {})
    };

    cfg.socialV2.voice = {
      enabled: false,
      dir: 'audio',
      maxSeconds: 300,
      maxBytes: 20 * 1024 * 1024,
      maxPerMinute: 2,
      maxPerHour: 10,
      allowAbsolutePath: false,
      defaultVolume: 1,
      loudness: 'normal',
      ffmpegPath: '',
      autoReadback: true,
      ...(cfg.socialV2?.voice ?? {})
    };

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

    cfg.socialV2.tieba = {
      cookieFile: '',
      ...((cfg.socialV2 && typeof cfg.socialV2.tieba === 'object' && !Array.isArray(cfg.socialV2.tieba)) ? cfg.socialV2.tieba : {})
    };

    cfg.socialV2.patrol = {
      enabled: true,
      dailyVisitCap: 12,
      maxPagesPerThread: 2,
      quietHours: [1, 8],
      ...((cfg.socialV2 && typeof cfg.socialV2.patrol === 'object' && !Array.isArray(cfg.socialV2.patrol)) ? cfg.socialV2.patrol : {})
    };

    cfg.dsh.authTokenExplicit = Boolean(cfg.dsh.authToken);
    if (!cfg.dsh.authToken) cfg.dsh.authToken = discoverDshLaunchToken();

    const storedDsh = file.dsh && typeof file.dsh === 'object' && !Array.isArray(file.dsh) ? file.dsh : null;
    if (storedDsh && Object.prototype.hasOwnProperty.call(storedDsh, 'reasoningEffort')) {
      const raw = storedDsh.reasoningEffort;
      if (raw === null) {
        cfg.dsh.reasoningEffort = '';
      } else if (typeof raw === 'string') {
        cfg.dsh.reasoningEffort = raw.trim();
      } else {
        cfg.dsh.reasoningEffort = '';
        log('⚠️ config.json 的 dsh.reasoningEffort 不是字符串，已按「未设置」处理（selectModel 将省略该字段）');
      }
    }

    cfg.role = { maxInjectChars: ROLE_INJECT_MAX_CHARS_DEFAULT, ...(file.role ?? {}) };
    roleInjectMaxChars = applyRoleInjectLimit(cfg.role.maxInjectChars);
    if (roleInjectMaxChars !== cfg.role.maxInjectChars) {
      log(`人格注入上限已按范围校正为 ${roleInjectMaxChars} 字符（配置值 ${cfg.role.maxInjectChars}，允许 1000~20000）`);
    }

    return cfg;
  }

  return {
    loadConfig,
    applyRoleInjectLimit,
    normalizeOwnerQQ,
    normalizeIdList,
    get roleInjectMaxChars() { return roleInjectMaxChars; },
    messages
  };
}
