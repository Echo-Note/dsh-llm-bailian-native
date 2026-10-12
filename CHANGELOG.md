# Changelog

本文件是 Release 说明的唯一来源：`release` 作业从对应版本区块生成
`release-notes.md`，因此「Release 说明」「CHANGELOG」说的是同一件事。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.8.0] - 2026-10-12

### Added

- **CI 现在负责构建与发布。** 推送到 `main` 时：校验 → 打包 → 解析版本与 tag →
  建 tag 与 GitHub Release（带 tarball 与 `SHA256SUMS` 附件）。发布是幂等的：
  用「`v<版本>` 是否已存在」判断，重跑只补缺失的步骤。
- `package` 作业用 `npm pack --dry-run` 断言 `files` 白名单真的覆盖了每个运行时文件
  ——「构建产物缺文件」这种问题不该等到安装时才暴露。
- Release 说明直接取自本 CHANGELOG 的对应版本区块（`scripts/release-notes.mjs`），
  因此 Release、CHANGELOG、包内副本说的是同一件事。
- `verify` 增加一条断言：`package.json` 的版本必须在 CHANGELOG 里有非空区块，
  否则发版会得到空说明。

## [0.7.4] - 2026-10-12

### Fixed

- **统计页打通了跨宿主数据链。** 设置页「百炼用量与价格」此前只能显示文字说明，
  因为宿主数据面缺失。现在整条链路可用：客户端 `remote.$mount(描述符)` →
  typert 网关 → 宿主 `bailianNative` 服务 → 真账单接口。
  逐个修掉的契约缺陷（每个都对应一次真实报错）：
  - 客户端描述符必须是完整 `InvocationDescriptor`（`id`/`service`/`namespace`/
    `method`/`invocation`/`parameters`/`result`），简写 `{ method }` 会在
    `$mount` 里抛 `descriptor.parameters is not iterable`；
  - loader 的 `validateTypertManifest` 要求 `model{services,events,objects}`、
    每个文档节点的 `tags` 数组、以及 **strict** result codec —— 缺 `model`
    会让命名空间根本不注册，调用得到 `HTTP 404`；
  - 宿主服务必须带**手写 `typertRemote` 绑定**（非枚举、不可写），否则报
    `Service "bailianNative" has no visible typertRemote binding`。

### Added

- 设置页四个数据面板：真账单（按月 + 按 `BASE_MODEL` 条形图 + 逐日分桶）、
  缓存收益（冷/热/节省）、本地价格表（含来源徽标）、连接状态。
- `lib/stats.js`：账单/缓存/价格聚合 + `createStatsService`（零参数 `snapshot()`）。
- `lib/typert.host.js`：手写宿主面清单。
- `.github/workflows/ci.yml`：校验、打包、按版本发布。

## [0.7.0] - 2026-10-12

### Added

- 账单接口 `ModelStudio 2026-02-10`：`GetBillingOverview` / `GetBillingTrend`，
  签名按官方文档实现 `ACS3-HMAC-SHA256`（`lib/billing.js`）。
- 一致性测试改为单一入口 `node tests/run.mjs`（4 个套件）。

### Fixed

- **缓存计费重复计费。** `inputTokens` 是请求的输入总量，`cacheReadTokens` 是
  其中的命中切片；两侧都按总量收费会让一次缓存命中比不命中**贵 16.6%**，
  方向完全相反。修正后实测同一请求 0.014808 → 0.0049776 CNY（**省 66.4%**）。

## [0.6.0] - 2026-10-12

### Added

- 设置页「百炼用量与价格」（`settings.section`，纯 JS 客户端 bundle，
  仅用主题 token，不 import 任何 Harness Client 包）。

## [0.5.0] - 2026-10-12

### Changed

- **不再自建账本。** 用量改走 harness 标准的 `usage` 分片通道，因此
  `dsh-cost-meter` 等统计插件无需接线即可读到同一份数字；自建第二份账本
  只会造成分叉。
- 插件退回**纯模型提供商**形态：删除自有 agent 工具与独立管理入口，
  配置权交回「设置 → 模型」。

## [0.4.0] - 2026-10-12

### Fixed

- 休眠路由的行标记为 `declared: true`（可采纳），否则模型页没有添加入口。
- `protocol` 字段不再用 `z.union` 限定：未知协议会被 schema 拒绝后**静默回落**，
  把「预留但未实现」的配置错误吞掉；改为显式报错。

## [0.3.0] - 2026-10-12

### Changed

- 适配器不再 import 任何 `@deepseek-ai/*` 包：本 profile 的 `node_modules` 是
  符号链接，Node 按插件**物理路径**解析，那里没有宿主包副本；而 profile 里
  存在的那份属于另一个 DSH 安装。改为按结构实现 `LlmAdapter`、自建带 `code`
  的错误，并把唯一编译期依赖 `schemastery` 内置在 `vendor/`。

## [0.2.0] - 2026-10-12

### Added

- 模型目录发现（`GET /api/v1/models`）、可版本化价格表（逐行带来源与核对日期）、
  目录刷新与失败降级。
- 端点/能力矩阵/价格来源/已知限制的完整 README。

## [0.1.0] - 2026-10-12

### Added

- 首个可用版本：阿里云百炼 / DashScope **原生协议**适配器，自有路由
  `bailian-native`（不占用既有 `bailian`），文本与多模态生成子路径按模型类别选择，
  SSE 分片翻译为 token 增量，工具调用、思考开关、稳定失败码。

[Unreleased]: https://github.com/Echo-Note/dsh-llm-bailian-native/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/Echo-Note/dsh-llm-bailian-native/compare/v0.7.4...v0.8.0
[0.7.4]: https://github.com/Echo-Note/dsh-llm-bailian-native/compare/v0.7.0...v0.7.4
[0.7.0]: https://github.com/Echo-Note/dsh-llm-bailian-native/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/Echo-Note/dsh-llm-bailian-native/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/Echo-Note/dsh-llm-bailian-native/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Echo-Note/dsh-llm-bailian-native/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Echo-Note/dsh-llm-bailian-native/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Echo-Note/dsh-llm-bailian-native/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Echo-Note/dsh-llm-bailian-native/releases/tag/v0.1.0
