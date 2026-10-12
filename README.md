# @local/dsh-llm-bailian-native

阿里云百炼 / DashScope **原生协议**模型提供方适配器（DeepSeek Harness bundle）。

推理链路只走 DashScope 原生 HTTP 接口，**不使用** `/compatible-mode/v1`。已有的 `bailian`
路由（`@deepseek-ai/dsh-llm-pi-ai` + `openai-completions`）不受影响：本插件用自己的路由名
`bailian-native`，重复注册同路由才会触发 `DUPLICATE_ADAPTER`。

---

## 1. 端点与协议

| 用途 | 方法 | 路径 |
|---|---|---|
| 文本生成 | POST | `{origin}/api/v1/services/aigc/text-generation/generation` |
| 多模态生成 | POST | `{origin}/api/v1/services/aigc/multimodal-generation/generation` |
| 模型目录 | GET | `{origin}/api/v1/models` |

- 鉴权：`Authorization: Bearer <API_KEY>`（`sk-` 开头；同一个 key 同时适用于公共域与业务空间专属域）。
- 流式：请求头 `X-DashScope-SSE: enable`；`parameters.stream` 只对 Python SDK 生效，HTTP 上不是开关。
- 请求体：`{ model, input: { messages }, parameters: { result_format: 'message', ... } }`，
  **`messages` 必须在 `input` 内**，所有采样参数必须在 `parameters` 内。
- 原生 SSE 分片：`output.choices[0].message.content`（**不是** 兼容模式的 `choices[0].delta.content`），
  且**每个分片都带 `usage`**。非终止分片的 `finish_reason` 是字符串 `"null"`。
- 原生流没有文档化的 `data: [DONE]` 哨兵；以 `finish_reason` 出现真实值为终止。本适配器也容忍网关追加的 `[DONE]`。

### `baseURL` 归一化（最容易踩的坑）

同一个 origin 同时提供 `/api/v1`（原生）、`/compatible-mode/v1`、`/apps/anthropic`。配置里可以填
主机名、`.../api/v1`，甚至直接粘贴兼容路由那串 `.../compatible-mode/v1`，适配器会剥掉已知协议前缀再拼原生路径：

```
https://dashscope.aliyuncs.com                                  -> https://dashscope.aliyuncs.com
https://dashscope.aliyuncs.com/api/v1                           -> https://dashscope.aliyuncs.com
https://llm-xxx.cn-beijing.maas.aliyuncs.com/compatible-mode/v1 -> https://llm-xxx.cn-beijing.maas.aliyuncs.com
https://gw.example/prefix/api/v1/services/.../generation        -> https://gw.example/prefix
```

### 两个域都可用，原生协议一致

| 域 | 说明 |
|---|---|
| `https://{WorkspaceId}.{region}.maas.aliyuncs.com` | 业务空间专属域，官方推荐的生产入口；同一 origin 同时提供原生与兼容协议 |
| `https://dashscope.aliyuncs.com` | 公共域，自 **2026-09-20** 起进入维护状态，**2026-09-30 后不再有新功能** |

API Key 是区域相关的：跨区域使用会返回 401；业务空间专属域只接受该空间的 key，否则报 `Model.AccessDenied`。

### 生成子路径按**模型类别**而非模态选择

最新的 Qwen3.5–3.8 旗舰/思考模型即使只发文本，也文档化在 **multimodal-generation** 路径上，
发到文本路径会得到 `url error`。所以 `generationPath` 默认 `auto`，按模型 id 判定；可用
`generationPath: text|multimodal` 或 `generationPathOverrides` 逐模型钉死。

---

## 2. 能力矩阵

| 能力 | 原生协议 | 本插件 |
|---|---|---|
| 文本生成 | 支持 | ✅ 流式 + 非流式 |
| SSE 流式 | 支持（`X-DashScope-SSE: enable`） | ✅ `incremental_output: true`，且额外做增量差分，兼容累积式分片 |
| 工具调用（function calling） | 支持（必须 `result_format: message`） | ✅ `tools` / `tool_choice: auto` / `tool_stream`；`qwen-vl` 系列官方暂不支持工具调用，由模型侧返回错误 |
| 推理（thinking） | `enable_thinking` + `thinking_budget`；thinking **只支持流式** | ✅ 映射 `reasoningEffort` → `off` 显式 `false`；开启时强制流式（非流式会在本地以 `INVALID_REQUEST` 失败而非发出必被拒的请求）。`reasoning_content` → `reasoning-delta` |
| 图片输入 | 原生部件是 `{ image: <url|data-url> }` | ⚠️ **部分**：仅当附件投影带 `dataUrl`/`base64` 时发送；单图 base64 上限 10 MB。持久附件字节在分发前被 harness 剥离，需要附件 seam 才能完整支持 —— 见「已知限制」 |
| 图片 token 计价 | `int(h*w/32²)+2`，默认上限 1280，`vl_high_resolution_images` 后 16384；响应报 `usage.image_tokens` | ✅ `imageRequestPricing` 声明按路由的视觉 token；`usage.image_tokens` 计入 `inputTokens` |
| 模型清单 | `GET /api/v1/models`（分页，含 `prices[]` 与 `equivalent_snapshot`） | ✅ 手动刷新 + 失败降级到上次成功目录，再降级到内置目录 |
| 提示缓存 | 显式缓存写 125%、命中 10%；隐式命中 20% | ✅ 未公布绝对价的模型按隐式 20% 推导并标 `official-derived`；`qwen3.8-max` / `qwen3.8-flash` 官方明确排除该规则，记 `cacheHit: null`（未知，不是 0） |
| 阶梯计价 | 按单次请求输入总量选档，**全部** token 按该档计价 | ✅ `pricing.<model>.tiers` |
| 批量半价 | 输入输出各 50%，与缓存折扣互斥 | ❌ 未实现（本插件不做批量提交） |
| 账单查询 | 需 `ModelStudio` OpenAPI + **AK/SK**（非 API Key） | ⏳ 可选扩展，未实现；见第 4 节 |

---

## 3. 配置

**配置入口就是主设置页 → 模型。** 本插件在模型管理里注册为**一个模型提供商行**（`LlmConfigurableProvider`），
配置卡片直接读写 `settingsPath = ["providers", "bailian-native"]`，API Key 以只写方式存进 credentials seam。
**不写密钥值，只写引用名。**

路由默认是**休眠**的：不写配置就没有路由、也没有凭据 —— 与 `llm-pi-ai` 的第三方提供商一致。
激活方式二选一：

1. **设置 → 模型 → 添加模型提供商**：选中本插件，填 baseURL，粘贴 API Key，「获取可用模型」拉取目录；
2. 或在 profile 的 `cordis.patch.yml` / `--patch` 覆盖层里写：

```yaml
- id: llm-bailian-native
  name: '@local/dsh-llm-bailian-native'
  config:
    providers:
      bailian-native:
        protocol: dashscope-native
        displayName: 阿里云百炼（原生协议）
        baseURL: https://llm-t0jjkadn2cznoq4n.cn-beijing.maas.aliyuncs.com
        apiKeyEnv: DASHSCOPE_API_KEY
        defaultModel: qwen3.8-flash
        modelDisabled: []
```

主要字段：

| 字段 | 默认 | 含义 |
|---|---|---|
| `protocol` | `dashscope-native` | 线协议；`tencent-native` / `baidu-native` 为预留键 |
| `baseURL` | `https://dashscope.aliyuncs.com` | 服务主机或基址，自动归一化（可粘贴 `/compatible-mode/v1` 那串） |
| `apiKeyEnv` | `DASHSCOPE_API_KEY` | 凭据引用名，经 credentials seam 解析 |
| `timeoutMs` | `600000` | 单次请求总时限 |
| `streamIdleTimeoutMs` | `300000` | 流分片间最大静默 |
| `models[]` | 内置目录 | 覆盖项，按字段合并 |
| `modelDisabled[]` | `[]` | 从目录与模型选择器中隐藏而不删除 |
| `generationPath` | `auto` | `auto` / `text` / `multimodal`；`auto` 按模型类别判定 |
| `pricing.models{}` | 内置价目表 | 逐模型单价覆盖（每 100 万 token） |
| `catalog.refreshMinutes` | `0` | `0` 关闭自动刷新；手动刷新始终可用 |

### 缓存命中：本提供商最主要的省钱杠杆

百炼的提示缓存是**自动生效**的（隐式缓存，无需 `cache_control` 标记），网关会在 `usage` 里回报命中量。
真机实测（`qwen3.8-flash`，同一段约 1.2k token 的前缀连发两次）：

| | inputTokens | cacheReadTokens | 按本插件价格表计费 |
|---|---|---|---|
| 第一次（冷） | 1231 | 0 | 0.00098750 CNY |
| 第二次（热） | 1231 | **1024** | 0.00033214 CNY |

**同一次请求便宜 66.4%**，节省 0.00065536 CNY。1024/1231 = 83% 的输入命中缓存。

计费口径（两条都必须同时成立，否则"省钱"会算错）：

1. **`inputTokens` 是输入总量**，`cacheReadTokens` 是**其中的命中切片**。所以未缓存部分是
   `inputTokens − cacheReadTokens`，命中部分再按缓存价计费。若两边都按总量收，会把命中 token
   **重复计费**——实测那样算会让一次缓存命中比不命中还贵 **16.6%**，方向正好相反。
2. `qwen3.8-max` / `qwen3.8-flash` 的缓存命中**绝对价官方未公布**（明确排除 10%/20% 规则、推给控制台）。
   价格表里该字段保持 `null`（**未知，不是 0**），计费时按官方**隐式命中 20%** 规则推导，
   并把结果标为 `cacheHitDerived: true` + `approximate: true`，同时给出 `cacheSavings`。
   如果你从控制台查到确切折扣，在 `pricing.models["<模型>"].cacheHit` 覆盖即可，覆盖值优先且不再标近似。

**结论：不要为了"省事"把未公布的缓存价记成 0 或记成原价**——前者会让费用虚低、后者会让费用虚高
并掩盖缓存收益。本插件的做法是"未知 + 保守推导 + 明确标注"。

### 统计页：百炼用量与价格

本插件注册了一个设置页（`settings.section`，`order: 35`），与 `cost-meter`、`skills-manager` 等第三方
插件用的是同一条路：自带一份纯 JS 客户端 bundle（`lib/client.js`，`dsh.client.platform = web`）。
四个面板：**连接**、**缓存收益**、**价格表覆盖**、**模型目录**，外加一个说明性的**账单对账**面板。
页面是**只读视图**，读的是「设置 → 模型」里同一个 `providers.bailian-native` 段；改配置仍在模型页。
样式只用 `--dsw-alias-*` 主题 token，不 import 任何 Harness Client 包。

### 账单接口：已实测可用（但需要 AccessKey，不是模型 Key）

`lib/billing.js` 实现了 `ModelStudio 2026-02-10` 的两个账单操作，签名按
[ROA风格请求体&签名机制](https://help.aliyun.com/zh/model-studio/roa-style-request-body-signature-mechanism)
的 `ACS3-HMAC-SHA256` 编写。**2026-10-12 用真实 AccessKey 跑通**：

| 月份 | 总额 | Top 模型（`groupBy=BASE_MODEL`） |
|---|---|---|
| 2026-09 | 95.87 CNY | text-embedding-v3 47.00、qwen3.6-plus 36.48、deepseek-v4-flash-0731 4.15 |
| 2026-08 | 1238.25 CNY | glm-5.2 1096.66、qwen3.6-plus 47.05、qwen3.7-plus 19.63 |
| 2026-10 | 151.20 CNY | deepseek-v4.1-flash 79.23、text-embedding-v3 71.94 |

`GetBillingTrend`（`granularity=DAY`）同样跑通，返回逐日 `resultByTime[]` 与按模型汇总。

**wire 格式是实测出来的，不是猜的**：

| 试法 | 结果 |
|---|---|
| `groupBy.1.code=BASE_MODEL` 或 `groupBy=[{"code":"BASE_MODEL"}]`（原始 JSON） | 400 `Telemetry.InvalidParams: groupBy required` |
| **`groupBy=[{"code":"BASE_MODEL"}]` 作为 JSON 字符串** | **200 ✅** |
| `POST` + JSON body | 404 `InvalidAction.NotFound`（该 API 只注册了 GET） |
| `timePeriod` 同理必须传 `{"start":"…","end":"…"}` 的 JSON 字符串 | 200 ✅ |

**为什么不能用模型 Key**（真机实测，非推断）：把 `sk-…` 当 Bearer 发送（无论是否补 `Date`/
`x-acs-action`/`x-acs-version`），网关回 `MissingAccessKeyId`，**与完全不带鉴权头时的响应逐字相同**
（即网关忽略该 Key）；把它当 `AccessKeyId` 塞进签名则回 `InvalidAccessKeyId.NotFound`。
两条产品线的凭据在服务端互不相通：模型 Key 是数据面，账单接口是管控面。

### 用量与统计的归属（重要）

本插件**不建自己的账本**。它按契约发出标准的 `usage` 分片（严格先于 `finish`），
由 harness 记录进会话，因此**任何**挂在同一条流上的统计/分析插件都读同一份数字：

- `dsh-cost-meter` 的取数路径是 `ctx.on('llm/stream', …)` + `sessionProjections.register(…)`，
  从 `assistant/chunk`（`chunk.type === 'usage'`）与 `assistant/message` 的 `data.usage` 读；
- 计费所需的价格表由本插件通过 `pricing` 暴露，**费用推算归统计插件**，本插件只保证 token 口径与
  价格来源（`source` / `verified` / `checkedAt`）可复算。

这样做是为了避免出现与 `dsh-cost-meter` 分叉的第二份账本。


---

## 4. 价格来源与账单边界

**价格来源**（读取于 2026-10-12，文档页标注更新时间 2026-10-11）：

- 中国内地价格页（CNY / 每百万 token）：<https://help.aliyun.com/zh/model-studio/model-pricing>
- 国际站价格页（USD / 每百万 token）：<https://www.alibabacloud.com/help/en/model-studio/model-pricing>
- 上下文缓存计费规则：<https://help.aliyun.com/zh/model-studio/context-cache>
- 视觉 token 换算：<https://help.aliyun.com/zh/model-studio/vision-model>
- 模型清单接口：<https://www.alibabacloud.com/help/en/model-studio/list-models>

内置价目表逐行带 `source` 与 `checkedAt`：`official`（照抄官方价目表）、
`official-derived`（按官方规则推导，如缓存 20%）、`user`（用户覆盖）、
`bundled-unverified`（未核实占位值，UI 与账本都会标注）。

**账单边界（本节已更正）**：**账单可以查，但不是用百炼 API Key。**

- 百炼 API Key（`sk-…`）只能调用模型。原生协议上与计费相关的接口只有
  `GET /api/v1/models`（目录，含 `prices[]`）与 `GET /api/v1/models/limits`（RPM/TPM **配额**，不是钱）。
- 真实账单走**另一个 OpenAPI 产品** `ModelStudio`（版本 `2026-02-10`，阿里云网关
  **AccessKey ID/Secret 签名**，不是 API Key）：
  - `GET /modelstudio/billing/overview` —— [文档](https://www.alibabacloud.com/help/en/model-studio/api-modelstudio-2026-02-10-getbillingoverview)；
    必填 `billMonth`(YYYY-MM) 与 `groupBy[].code`（**只允许一个**维度）；可选 `filter`、`topNum`(1–20)、`regionId`、`locale`；
    返回 `data.{currency,totalAmount,pretaxAmount,taxAmount,groups[]{key,name,amount,percentage}}`。
  - `GET /modelstudio/billing/trend` —— [文档](https://www.alibabacloud.com/help/en/model-studio/api-modelstudio-2026-02-10-getbillingtrend)；
    必填 `granularity`(DAY|MONTH) 与 `timePeriod.start/end`；返回
    `data.{costTotals{amount,pretaxAmount,taxAmount,currency},groupByTotal[],resultByTime[]{period,total,periodDetails[]}}`。
  - 可用维度（两个接口通用）：`BASE_MODEL`（按模型）、`API_KEY_ID`、`WORKSPACE_ID`、
    `MAAS_TYPE`（inference / training / model_units / capacity_reserved）、`CHARGE_TYPE`（postpaid / prepaid）、
    `BUSINESS_REGION`、`SERVICE_SITE`、`FEE_TYPE`、`ARTICLE_CODE`。
- 所以完整方案是**两条腿**：本地令牌计量回答"这次调用花了多少"，账单接口回答"实际扣了多少"，
  两者按 `BASE_MODEL` 维度对账。账单接口需要**单独配置 AK/SK**（仍只存引用名，绝不落明文），
  属于本期的**可选扩展，尚未实现**。

三个必须知道的偏差：

1. 本地推算基于**标价**，不含限时折扣、夜间/错峰折扣与节省计划 —— 实际账单通常**更低**，本地值是**上界**。
2. 同一模型在中国内地页是 CNY、国际站页是 USD，**不能混列**。路由的 `pricing.currency` 决定账本币种。
3. 文档只给到页面级更新时间，没有逐模型生效日期；限时折扣无结束日期。

---

## 5. 失败码

失败一律映射为稳定 code（上层按 code 路由，绝不解析消息文本）：

| code | 触发 |
|---|---|
| `NO_ADAPTER` | 路由不存在 / 未注册 |
| `MISSING_CREDENTIAL` | `apiKeyEnv` 指向的引用未配置 |
| `INVALID_CREDENTIAL` | 密钥为空或含 HTTP 头无法承载的字符（只报引用名，绝不回显密钥） |
| `AUTH` | `InvalidApiKey` / `invalid_api_key` / `NOT AUTHORIZED`；401/403（常见原因：区域或计费计划与端点不匹配） |
| `RATE_LIMIT` | `Throttling.RateQuota`；429。带 `Retry-After` 时回填 `providerRetryAfterMs` |
| `QUOTA` | `Arrearage` / `AllocationQuota.FreeTierOnly` / `Throttling.AllocationQuota` / `isv.OUT_OF_SERVICE`；402 |
| `CONTEXT_WINDOW_EXCEEDED` | `Range of input length…`（该条件挂在 `InternalError.Algo.InvalidParameter` 下，仅靠 code 无法区分，因此先判消息） |
| `INVALID_REQUEST` | `InvalidParameter*` / `BadRequest.*` / `DataInspectionFailed` / `Model not exist.` / `Model.AccessDenied` |
| `SERVER` | `InternalError*` / `No backend server available`；5xx |
| `TRANSPORT` | 连接层失败（含 cause 摘要） |
| `TIMEOUT` | 总时限或流静默超限 |
| `ABORTED` | 调用方取消 |
| `STREAM_CLOSED` | 流一个分片都没发就结束 |
| `MALFORMED_RESPONSE` | 分片不是 JSON / 2xx 但非 JSON |
| `EMPTY_RESPONSE` | 成功但无任何文本、思考或工具调用（按重试策略可重试） |
| `INVALID_CONFIG` | 路由配置无法解析（同时出现在设置页诊断里） |

---

## 6. 腾讯云 / 百度云扩展接口（本期**不实现**）

插件从第一天就是多提供方宿主，而不是单厂商适配器：

- `lib/protocol.js` 定义 `ProtocolAdapter` 契约（`buildRequest` / `parseReply` /
  `parseStreamFrame` / `mapError` / `probe` / `listEndpointModels` / `priceImageRequest`）。
- `lib/providers/index.js` 是协议注册表。`tencent-native` 与 `baidu-native` 已登记为**预留键**：
  用户在配置里写它们会得到一条可执行的诊断，而不是「未知协议」。
- 配置、凭据解析、目录刷新、价格表、账本、失败码与 UI 全部**与厂商无关**。

新增一家云的做法（三步，无需改核心）：

1. 新建 `lib/providers/<vendor>/<protocol>.js`，导出一个 `ProtocolAdapter`；
2. 在 `lib/providers/index.js` 里 `registerProtocol('tencent-native', adapter)`；
3. 在 `lib/catalog.js` 增加该协议的目录条目。

---

## 7. 已知限制与未决项

- **图片输入只部分支持**：harness 在分发前会剥离持久附件的字节，只留下确定性句柄文本。
  因此原生 `{ image: ... }` 部件只在调用方提供了内联 `dataUrl`/`base64` 时才会发出；
  完整支持需要接入附件 seam（`ctx.get('attachments')`）并把字节读出来。内置目录只为
  VL/Omni 模型声明 `image` 模态，避免把图片发给会拒绝它的模型。
- **未实现批量半价**（不做批量提交）、**未实现错误峰计价**（中国内地价目表本身没有错峰标签）。
- **账单核对未实现**：真实账单走 `ModelStudio` OpenAPI 的 `GetBillingOverview` / `GetBillingTrend`，需要**单独的 AK/SK**（不是百炼 API Key），属于可选扩展。
- **`qwen-turbo` / `qwen-vl-max` / `qwen-vl-plus` / `qwen2.5-vl` 不在内置目录**：它们已从
  当前模型与价格文档中消失，内置它们等于宣传无法承诺的模型。目录刷新会以端点结果为准。
- **模型 ID 与价格会变**：内置目录是离线兜底，权威来源是 `GET /api/v1/models` 与官方价格页。
- **`qwen3.8-max` / `qwen3.8-flash` 的缓存命中价官方未公布**（明确排除 10%/20% 规则），
  本地记 `cacheHit: null` 并按未缓存价估算，费用标为近似。
- **单次请求只尝试一次**：重试由 `@deepseek-ai/dsh-llm-retry` 在 agent 失败步边界执行；
  本插件声明的可重试码为 `EMPTY_RESPONSE` / `RATE_LIMIT` / `SERVER` / `TIMEOUT` / `TRANSPORT`。
- **DSH 处于预览期**：版本敏感的调用集中在 `lib/index.js` 与 `lib/credentials.js`；
  `lib/providers/**` 与 `lib/stream.js` 只依赖 `fetch` / `AbortSignal` / `TextDecoder`。
- **不导入任何 `@deepseek-ai/*` 包**：本 profile 的 `node_modules` 是符号链接，Node 会按插件**物理路径**
  解析，那里没有宿主包副本；而 profile 里确实存在的那一份属于**另一个 DSH 安装**，跨版本混用会崩。
  因此适配器按结构实现 `LlmAdapter`（宿主只鸭子类型调用它的 7 个方法）、自建带 `code` 的错误，
  并把唯一的编译期依赖 `schemastery` 内置在 `vendor/`。

---

## 7.5 真机验证记录（2026-10-12）

对 `https://llm-t0jjkadn2cznoq4n.cn-beijing.maas.aliyuncs.com`（业务空间专属域，配置里故意传
`/compatible-mode/v1` 以验证归一化）实测：

| 检查 | 结果 |
|---|---|
| `baseURL` 归一化 | `.../compatible-mode/v1` → `https://llm-t0jjkadn2cznoq4n.cn-beijing.maas.aliyuncs.com` |
| 子路径自动选择 | `qwen3.8-flash` → `/api/v1/services/aigc/multimodal-generation/generation`（家族规则） |
| 真实流式 | 返回 `PONG`；分片类型 `block-start, reasoning-delta, text-delta, usage, finish` |
| 流契约 | 恰好 1 个 `finish`，`usage` 在 `finish` 之前 |
| usage 口径 | `inputTokens 67 / outputTokens 28 / reasoningTokens 24 / totalTokens 95`，`cacheReadTokens 0` |
| 模型目录 `GET /api/v1/models` | `supported: true`，返回真实模型集（`qwen3.8-max`、`qwen3.8-max-0902`、`qwen3.8-flash`、`qwen3.7-plus`、`qwen3.7-max`、`qwen3.7-flash-2026-07-15` …），并带 `request_modality` |
| 错误 key | `AUTH`，401，含 `request_id`（`InvalidApiKey`） |
| 缺凭据 | `MISSING_CREDENTIAL`，且**不发任何请求**（回归测试断言 `fetch` 未被调用） |

两点值得注意的实测事实：

1. 该网关对 `qwen3.8-flash` **默认开启思考**（未传 `enable_thinking` 仍返回 `reasoningTokens`），
   且官方文档确认 thinking **只支持流式**。本适配器始终走流式，因此这条约束天然满足。
2. 模型目录宣称 `qwen3.8-flash` 的 `request_modality` 含 `image`，但本插件**尚不能完整发送图片**
   （见第 7 节：持久附件字节在分发前已被 harness 剥离）。

### 写配置时的 patch 方言（实测）

bundle 自带的 `cordis.patch.yml` 用 `insert` 插入插件行；此后**用户层要改这一行的配置，必须用
「按 id 覆盖」形态**（只有 `id`，没有 `insert`）：

```yaml
- id: llm-bailian-native          # 已存在的行 → 覆盖其字段，config 整体替换
  name: '@local/dsh-llm-bailian-native'
  config:
    providers: { ... }
```

反过来，如果把它写成 `insert`，在**没有该行**的 profile 里才有效；在已经有了的 profile 里
`--patch` 会报 `entry "llm-bailian-native" not found`（我用同一个 Loader 实测过）。
注意 `config` 是**整体替换**而非深合并，所以覆盖时必须把该行需要的字段都写全。

桌面 profile 由 Electron 独占，`dsh --dump-config` 对它不可用；组合结果我用同一条 CLI
在另一个 profile 上以 `insert` 形态独立验证过（无 warning，行与 `providers.bailian-native` 完整保留）。

---

## 8. 开发与验证

```sh
# 离线 wire 层检查：不联网、不依赖 DSH、不读宿主包
node tests/native-stream.test.mjs

# 真机验证（会发真实请求；密钥只从环境变量读，不要写在命令行上）
DASHSCOPE_API_KEY=... node tests/live-native.test.mjs \
  https://llm-xxx.cn-beijing.maas.aliyuncs.com/compatible-mode/v1 qwen3.8-flash
```

安装（由 `plugin_manager` 的 `install_bundle` 完成，不要手写 profile 文件）：

```
plugin_manager { action: "install_bundle", target: "<本目录绝对路径>" }
```

卸载即回滚：`plugin_manager { action: "remove_bundle", target: "@local/dsh-llm-bailian-native" }`。

本插件**不注册 agent 工具**：它只是模型管理里的一个提供商，配置与目录刷新都在
**设置 → 模型** 的那一行里完成。
