# qq-bridge（v2 二代仿真）本地模型选型与硬件配置

> 结论摘要：**当前 `deepseek-flash`（= DeepSeek-V4.1-Flash）没有公开权重，本地无法复刻。**
> 本地可用的最低门槛是 **27–35B 级（MoE / dense）**，单卡 24GB 属于勉强，**双 3090（48GB）是性价比拐点**。
> 9B 级不足以驱动本项目的 41 个工具。详见下文。

调研日期：2026-09-17。基于本仓库实际代码 + DSH 0.1.5-rc.1 实测 + 外部调研。

---

## 一、这个 bot 对模型的真实负载（实测，不是估计）

| 项目 | 实测值 | 来源 |
| --- | --- | --- |
| 暴露给模型的工具 | **41 个**（snowluma 36 + web-search 2 + host 3） | `src/mcp-snowluma-safe.js` 等 `server.tool(` 计数 |
| `qq-chat-v2` preset 人设正文 | 17,145 字符 / 10,096 汉字 → **约 8k–12k token** | `dsh/agent-presets/qq-chat-v2/agent.cordis.yml` |
| 工具 schema JSON 体量 | 约 6k–12k token | 按 41 个工具的 zod schema 估算 |
| **固定前缀合计** | **约 15k–26k token** | 每次工具调用都要重发 |
| 单回合总上下文 | **约 22k–58k token** | 含消息历史 / 图片 / 多步工具结果 |
| 会话寿命 | 数小时～数天，必然触发 compaction | `config.json` 的 `socialV2` |

### 关键约束：中文会让 DSH 的压缩算晚

DSH 的 token 计量是固定启发式 `CHARS_PER_TOKEN = 4`
（`dsh-token-meter/lib/index.js:16`），压缩阈值 = `contextWindow × 0.8`。

本项目 preset 的 `prefix` 是 17,145 字符，DSH 只算约 4,300 token，
但中文实际约 8k–12k token —— **低估约 2 倍**。
更糟的是它按字符数（不是 UTF-8 字节）计算，所以这个偏差不会自我修正。

**后果**：在 64k 上下文的本地模型上，压缩会在实际已用到 70k–100k token 时才触发 → 服务端直接溢出。
**对策**：把 `thresholdRatio` 调低到 0.4–0.5，并如实声明 `contextWindow`（pi-ai 路由默认值是 262,144，不声明就永远不压缩）。

---

## 二、`deepseek-flash` 是什么？能本地跑吗？

**`deepseek-flash` = DeepSeek-V4.1-Flash**，2026-09-10 发布，官方 changelog 原文：

> "Change the model name to `deepseek-flash` to call the latest V4.1 Flash model. The previous-generation
> models V4 Flash and V4 Flash Vision Exp have been retired; for compatibility, the model names
> `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are temporarily routed to V4.1 Flash."

- 它是 V4 **点 1** Flash（不是 "V41" 型号），V4 架构家族里最小的模型，原生多模态。
- Terminal-Bench 2.1 **90.6**、GPQA-D 90.9、HLE w/tools 63.9。
- ❌ **没有公开权重**，只有 API。

**开源的同门兄弟落后一代**：`deepseek-ai/DeepSeek-V4-Flash`（284B 总参 / 13B 激活，MIT 许可）。
但它的 Unsloth GGUF 量化后仍有 **155GB（Q4）～162GB（Q8）**，
vLLM 官方配方最小验证配置是 DGX Station / 2× DGX Spark / 8× RTX PRO 6000。

> **所以：本地跑不出当前这个 bot 的"大脑"。** 这是本次调研最重要的结论。

---

## 三、本地模型分级结论

| 档位 | 代表模型 | 权重显存(Q4) | 对本项目 | 说明 |
| --- | --- | --- | --- | --- |
| 7–9B | Qwen3.5-9B 等 | ~5–6 GB | ❌ **不可用** | 41 个工具 + 15k 固定前缀扛不住；仅适合做路由/分类/向量 |
| 14B | Qwen3-14B 级 | ~8–9 GB | ⚠️ 勉强 | 上下文与工具纪律都很紧 |
| **27–35B** | **Qwen3.6-35B-A3B（3B 激活）** / Qwen3.6-27B / GLM-4.7-Flash | **~16–22 GB** | ✅ **本地现实下限** | SWE-bench 73.4 / TB2.0 51.5；35B-A3B 为多步工具循环优化 |
| 70–122B | Qwen3.5-122B-A10B | ~70 GB | ✅ 可用但性价比低 | BFCL 0.722 vs 27B 的 0.685，收益远小于 4× 显存 |
| 前沿开源 | GLM-5 (744B) / Qwen3.5-397B / Kimi K2.5 | 220GB–1.5TB | ❌ 数据中心 | 非消费级 |

### 工具数量会放大差距（这是本项目最大的风险）

公开数据（BFCL-v3 派生，May 2026，**厂商自报，谨慎采信**）：

| 模型 | 1 个工具 | 5 个 | 20+ 个 |
| --- | --- | --- | --- |
| 闭源前沿 | 95–96% | 85–91% | 65–78% |
| Qwen3-32B | 89% | 82% | **58%** |
| Llama-4-70B | 87% | 79% | 54% |

**开源模型在 1 个工具时落后 5–12%，到 20+ 个工具时落后 10–22% —— 差距随工具数扩大。**

失败原因分解（20+ 工具时）：参数不匹配 ~38% + 类型强转 ~24% + 缺参数 ~12% = **约 62% 是参数/类型问题**；
**"编造工具名"只占 ~5%** —— 也就是说你担心的错，其实不是主要风险；
真正的风险是 `messageId`（有符号整数）被当字符串传、`key` 格式写错这类。

多步误差累积（按 90%/次 估算）：2 步 81%、3 步 73%、5 步 59%、**10 步 35%**。
QQ bot 一个回合通常是「看消息 → 看图 → 发消息」3 步以上。

---

## 四、硬件配置建议

### 硬性资源

| 项目 | 需求 |
| --- | --- |
| 显存/统一内存 | 27–35B @ Q4 ≈ 16–22GB 权重 + KV cache |
| 上下文 | **至少 32k，推荐 64k+**（固定前缀就 15k–26k） |
| KV cache（fp16） | 30B-A3B 级：32k≈3GB，64k≈6GB，128k≈12GB |
| 磁盘 | 20–25GB/模型（Q4 GGUF/AWQ） |
| 系统内存 | ≥32GB（含 DSH + 桥接 + SnowLuma + 模型加载缓冲） |

### 推荐配置档位

| 档 | 配置 | 预期 | 评价 |
| --- | --- | --- | --- |
| 入门 | 单卡 24GB（3090/4090）+ 35B-A3B Q4，llama.cpp | 勉强，需把上下文压到 32k | 能跑，工具出错率会明显高于 API |
| **推荐** | **2× 二手 3090（48GB），vLLM TP=2** | 262k 上下文，多流稳定 | **性价比拐点**；TP=2 同时规避单卡长上下文悬崖 |
| 省心 | Mac M3/M4 Max 64GB+，MLX | 35B-A3B Q4 约 60–70 tok/s | 统一内存要留给系统和 KV |
| 不推荐 | 纯 CPU + 内存 | 个位数 tok/s（未获可信实测） | 只能做路由，不能做大脑 |

> ⚠️ **单卡 vLLM 长上下文悬崖**：club-3090 项目记录了一个物理悬崖——
> 单卡 vLLM 在**累积约 21k–26k token / 4–5 轮**后会退化到吞吐 0 或 OOM，
> 反复调参（mem-util、关 MTP、max-num-batched-tokens）都无法解决，**只有 TP=2 能绕开**。
> 其警告名单明确包含 OpenClaw / Cline / Roo / Aider 这类**累积上下文的 agent**——正是本项目的形态。
> （该来源为二手转述，未能取回原文核实，但与本项目"固定 15k 前缀 + 长期累积"的负载高度吻合，建议认真对待。）

### 服务端选型

| 方案 | 工具调用 | 评价 |
| --- | --- | --- |
| **vLLM** | ✅ 但**必须显式加** `--tool-call-parser <name>` + `--enable-auto-tool-choice` | 首选；两个参数默认关闭，漏了会静默失效 |
| llama.cpp | ⚠️ 上游 server 无 auto tool choice，需 wrapper | 跨平台/最简；长上下文能力弱于 vLLM |
| SGLang | ✅ | RadixAttention 前缀共享最好，多租户吞吐高 10–30% |
| **Ollama** | ❌ 2026 年对 agent 场景不可用 | Qwen3.5 工具调用有 open issue；vision 未打包 mmproj；流式会破坏工具调用 |

**前缀缓存是最大的一笔收益**：本项目的固定前缀（人设 + 41 个工具 schema）每次工具调用都重发，
开启 prefix caching 后可把这段 prefill 变成每会话一次性成本。务必打开。

---

## 五、具体接入方式（DSH 侧）

DSH 已内置 `llm-pi-ai` 适配器（`dsh-base` 的 `cordis.patch.yml:100-108` **休眠挂载**），
指向 llama.cpp / Ollama / LM Studio / vLLM 只需在 `~/.dsh/settings.yaml` 加一个 `llm-pi-ai:` 段，**免重启**：

```yaml
llm-pi-ai:
  providers:
    local:
      displayName: Local vLLM
      api: openai-completions
      baseURL: http://127.0.0.1:8000/v1
      apiKeyEnv: LOCAL_LLM_API_KEY      # 无密钥的本地服务也必须给占位凭据，见下
      defaultContextWindow: 65536
      defaultInput: [text, image]        # 仅在服务端真支持 vision 时声明
      compat:
        supportsDeveloperRole: false     # 发 system，不要发 developer
        maxTokensField: max_tokens       # llama.cpp/vLLM 认 max_tokens
        supportsStore: false
        supportsReasoningEffort: false
        supportsUsageInStreaming: false
        supportsStrictMode: false
      models:
        - id: qwen3.6-35b-a3b            # 与 vLLM --served-model-name 一致
          contextWindow: 65536           # 必须等于服务端真实上下文
          maxTokens: 4096                # 同时成为该模型每次请求的输出上限
          reasoningEfforts: false
```

然后**改 `qq-bridge/config.json`**（桥接会按会话调用 `session.selectModel` 强制切换）：

```json
"dsh": { "provider": "local", "model": "qwen3.6-35b-a3b", "reasoningEffort": "" }
```

### 四个必踩的坑

1. **"无密钥"不是真的无密钥**：pi-ai 的 OpenAI 实现即使对本地服务也要求
   `apiKey` 或 `Authorization` 头，否则抛 `No API key for provider`。给个占位值即可。
2. **`reasoningEffort` 必须清空**：现在 `settings.yaml` 与 `config.json` 里都是 `max`，
   本地非推理模型会**在发请求前**就以 `UNSUPPORTED_REASONING_EFFORT` 失败。
3. **必须如实声明 `contextWindow`**：pi-ai 路由默认 262,144，不声明 → 压缩永不触发 → 溢出。
   同时建议把 `dsh-compaction-basic` 的 `thresholdRatio` 降到 0.4–0.5（原因见第一节）。
4. **compat 必须手配**：pi-ai 的 `detectCompat` 靠 baseURL 子串识别厂商，
   `127.0.0.1` 匹配不上 → 被当成真 OpenAI → 发 `developer` 角色、`max_completion_tokens`、
   `store`、`strict` 等本地服务不认的字段。

### 视觉能力

- 本项目**依赖视觉**：preset 第 21 条要求模型对 `[图片]` 调用 `qq_get_message_images` 并自然回应。
- DSH 侧要声明 `input: [text, image]`，且**图像只能出现在 user 角色消息里**
  （system/assistant 里的图会以 `UNSUPPORTED_CONTENT` 失败）。
- 声明 image 是**声明而非校验**：服务端不支持的话会在回合中途才失败，且图片已留在历史里，可能反复失败。
- 本地视觉模型（如 Qwen-VL 系列）在中文表情包/梗图上的理解明显弱于 DeepSeek-V4.1-Flash。

---

## 六、推荐路线

1. **主力仍是 API**（`deepseek-flash`）。本项目 preset 是围绕它 90.6 的 Terminal-Bench 2.1
   和多模态能力写的，换本地模型等于同时下调工具纪律、中文语感、视觉理解、上下文四项。
2. **想试本地**：从 **Qwen3.6-35B-A3B（Q4）+ 双 3090 + vLLM** 起步，
   先跑 `reserved2` 在**单个白名单群**里观察，重点看：工具调用成功率、是否编造参数、中文语感、图片理解。
3. **混合架构（最推荐）**：本地模型只承担
   - 向量检索 / 记忆召回（embedding）
   - 消息分类 / 路由 / 唤醒决策
   - 低风险闲聊回合

   而**需要多步工具编排的回合仍走 API**。
   已有真实部署的 QQ bot（`MagicIndex135731/Komachi-qq-aibot`）采用完全相同的分工：
   > "GPU 只用于小町本地向量模型，不分配给 LLBot" —— GPU 只跑本地向量模型，认知走 API。

4. **如果坚持全本地**：预算目标定为 **2× 二手 3090（48GB）**，
   并给桥接补一层**工具参数校验 + 失败回喂重试**（公开数据：重试可挽回 8–15% 的失败回合）。
   本项目 bridge.js 已有参数校验基础，值得加强。

---

## 七、数据可信度声明

- ✅ **一手核实**：工具数量、preset 体积、DSH 计量公式、`llm-pi-ai` 配置面、
  `deepseek-flash` = V4.1-Flash（已取回官方 changelog 原文核对）。
- ⚠️ **二手，未能取回原文**：club-3090 的单卡长上下文悬崖、各模型 2026 年的 tokens/s 实测。
- ⚠️ **厂商自报，未经独立复现**：所有 BFCL-v4 数字（llm-stats 自己的标注是 "Verified 0 / Self-reported 22"）。
  本文中的工具数量退化表基于 BFCL-v3，列出的是 Qwen3-32B / Llama-4-70B 等 2026 年前的模型，
  **只反映曲线形状，不代表 2026 年绝对值**。
- ❌ **证据缺口**：没有找到针对中文群聊人格漂移 / 负向约束遵循的严谨 benchmark。
  也就是说，**本项目最在意的"AI 味 / 人设漂移"，恰恰是业界最没有量化测量的部分**。
