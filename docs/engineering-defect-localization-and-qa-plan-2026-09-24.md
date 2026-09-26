# 工程缺陷定位与 QA 收口规划（2026-09-24）

## 0. 文档目的

这不是“测试通过报告”，而是一份面向下一轮工程整改的缺陷定位与验收规划。它把当前问题分成四类：

1. 已由当前源码或实跑直接证明的缺陷；
2. 已能定位到代码路径、但还需要最小反例确认的高风险候选；
3. 测试体系的明确盲区；
4. 不属于代码 bug、但会让完成度判断产生假阳性的发布、文档和 Task Forest 状态问题。

本轮只读审计基线：`HEAD=c01208cbb7ad908bebcd8d5219431ce69471873c`，`main` 与 `origin/main` 同步，工作树干净。本文不改变生产代码、Task Forest canonical 数据或产品开关。

## 1. 产品与工程边界

Workbench 是本地优先的前提账本：`.workbench/` 保存 YAML/JSONL 状态和追加式事件；CLI、HTTP、MCP 与聊天 UI 共享 Blackboard。当前产品形态是 CLI + 本地 Web 面板 + 聊天内账本能力，不是旧 Helmor 的 Tauri/Rust/SQLite/sidecar 桌面应用。

当前聊天车道有两条本机 CLI 路径（Claude、Codex）和三条 HTTP 纯文本路径。前提封印是 hook 边界，不是全局写保护：Claude Code `PreToolUse` 会调用 `premises seal`；Git、裸编辑器和 Codex 写入不经过该拦截点（[AGENTS.md:232](../AGENTS.md#L232)；[ADR-0017:29](decisions/0017-second-observable-provider-integration.md#L29)）。

因此验收必须同时回答两件事：

- 工程代码是否按声明工作；
- 声明的能力是否在真实生产写者、真实浏览器和真实发布物上成立。

## 2. 当前已验证门禁

| 门禁 | 当前结果 | 解释 |
| --- | --- | --- |
| TypeScript | exit 0 | 三个 package 的 `tsc --noEmit` 通过 |
| Biome | exit 0 | 608 个文件，无修复项 |
| Workbench suite | 973 pass / 0 fail | 150 文件；含真 CLI、真 HTTP、真 Git 的脚本场景，但仍是脚本驱动 |
| Workbench UI Vitest | 67 pass / 0 fail | 18 文件；不是浏览器验收 |
| context-rot | 68 pass / 0 fail | 6 文件 |
| doctor | exit 0 | blackboard 正常，rot stale=0 |
| Task Forest validate/check-landing | exit 0 | 结构/落库一致，不证明产品价值 |
| 本机与四平台构建 | exit 0 | 交叉编译成功；非 Windows 仅验证产物形态 |
| `test:build` | exit 0 | native 与 JS 两种产物的无头 smoke 通过 |
| Playwright `test:e2e` | 当前无法验收 | 14 个测试在启动浏览器前失败，Chromium executable 缺失 |
| `test:live` | 未执行 | 缺少 `E2E_LLM_KEY` / `E2E_LLM_MODEL`，脚本 fail-closed |

## 3. 已确认缺陷与高风险候选

### F-01 [P1] 浏览器门禁未接入 CI，且 provider 断言已过时

**证据**

- 生产 provider 列表已有 Claude、Codex、三个 HTTP provider：[settings-fields.tsx:4](../apps/workbench-ui/src/components/chat/settings-fields.tsx#L4)。
- 浏览器测试仍固定断言选项数为 4：[dropdown.spec.ts:32](../apps/workbench-ui/e2e/dropdown.spec.ts#L32)。
- CI 的 UI job 只运行 Vitest 和 `build:ui`，没有 `test:e2e`：.gitlab-ci.yml:168（该文件已按 ADR-0021 删除，链接不再可跟）。
- 规划和草稿恢复测试在缺少预置会话时主动 `test.skip`：[ui.spec.ts:76](../apps/workbench-ui/e2e/ui.spec.ts#L76)、[ui.spec.ts:161](../apps/workbench-ui/e2e/ui.spec.ts#L161)。

**影响**

“67 个 UI 测试通过”不能证明真实浏览器路径正确；Codex 接入已经造成一个静态可见的旧断言，CI 仍然会放绿。

**最小复现**

1. 安装匹配版本的 Playwright Chromium；
2. 启动 `workbench ui` 与 Vite；
3. 运行 `cd apps/workbench-ui && bun run test:e2e -- e2e/dropdown.spec.ts`；
4. 预期 provider dropdown 的 `toHaveCount(4)` 与实际 5 项冲突。

**关闭条件**

- 断言从共享 provider 能力数据推导，不再复制常量；
- CI 在隔离 workspace 中运行浏览器 suite；
- 报告明确区分 `passed`、`failed`、`skipped`，并禁止无会话时把关键场景静默 skip；
- 至少覆盖设置、草稿切换/恢复、计划模式、窄屏布局和 Codex 选择持久化。

### F-02 [P1] 发布物与当前源码分叉

当前 `workbench-v0.4.0` tag 指向旧提交 `9ec88c9`，而当前 `HEAD` 已在其后多个提交；`packages/workbench/CHANGELOG.md` 顶部的 P0–P5 审计修复仍位于 `Unreleased`。[CHANGELOG.md:3](../packages/workbench/CHANGELOG.md#L3)

**影响**

下载公开 0.4.0 的用户拿不到当前封印、doctor、静默吞错、测试假阳性和模块拆分修复。旧 JihuLab/release-build 读数也不能自动证明当前 HEAD 的发布形态。

**关闭条件**

- 从当前受验收的 commit 重新生成版本、CHANGELOG、tag 和 Release；
- 发布前固定 `source HEAD`、tag commit、资产 SHA256、测试 commit 四元组；
- Release notes 明确哪些平台真正运行过测试；
- 发布后用下载的二进制，而不是 workspace 内产物，重复 `init → doctor → ui → API` smoke。

### F-03 [P1] Codex approval/seal 路径不是写安全闭环

Codex 服务请求统一 auto-accept，且不解析 approval params；`decideSeal` 只从 Claude Code hook 调用：[protocol.ts:29](../packages/workbench/src/chat/codex-app-server/protocol.ts#L29)。ADR-0017 也明确记载：保留夹具主要覆盖 `read/listFiles`，写动作、`fileChange/fileRead` approval 和 stale-premise 阻断没有证据。[ADR-0017:49](decisions/0017-second-observable-provider-integration.md#L49)

**影响**

Codex 的“可观测 provider 已接入”目前只证明协议翻译、进程生命周期和读足迹；不能证明 Codex 写入会被封印、只读区域会被拒绝、写足迹会正确归因。

**关闭条件**

- 采集一个真实 Codex approval + file write 会话；
- 写入失效前提、只读区域、正常区域各跑一次；
- 证明 approval 响应、写足迹、`seal.decided`、回合结果和重启恢复之间的关联；
- 若产品选择保持 auto-accept，必须把“Codex 不受 seal 保护”升级为显著的产品限制，而不是写成与 Claude 等价。

### F-04 [P1] 非法 JSON 在部分写 API 上被静默当成空对象

`chatRoute` 对创建线程、分叉、切换、恢复笔记等请求使用 `request.json().catch(() => ({}))`；例如创建线程在 malformed JSON 时会继续调用 `chat.create(undefined)`：[chat-routes.ts:18](../packages/workbench/src/ui/chat-routes.ts#L18)。这与其他路由直接抛错或返回 400 的行为不一致。

**影响**

客户端网络截断、错误 `Content-Type` 或代理损坏时，API 可能执行“默认动作”而不是拒绝请求；切换/反馈类接口还可能写入不完整的审计事实。

**最小复现**

- 对 `/api/chat/threads`、`/fork`、`/switch`、`/resume-note` 发送 `Content-Type: application/json` 但 body 为 `{`；
- 记录 HTTP 状态、线程数量、events.jsonl 和响应体；
- 预期所有 malformed body 都是 400，且没有状态/事件变化。

**关闭条件**

- 共用严格 JSON body parser；
- malformed JSON、数组、null、未知字段分别有 400/明确 schema 行为；
- 所有写路由都有“请求失败不产生事件/不改变状态”的反例测试。

### F-05 [P2] UI 资源损坏会以 HTTP 200 fallback 冒充健康

`loadEmbeddedFiles()` 捕获所有导入错误并返回空对象：[assets.ts:39](../packages/workbench/src/ui/assets.ts#L39)；服务器随后把 `FALLBACK_PAGE` 作为正常 HTML 返回：[server.ts:89](../packages/workbench/src/ui/server.ts#L89)。现有测试只验证 fallback kind 合法和 happy-path disk assets，没有注入损坏 manifest/缺失 embedded asset 的失败场景。[server.test.ts:29](../packages/workbench/src/ui/server.test.ts#L29)

**影响**

进程存活、端口可访问、HTTP 200 都可能同时成立，但用户看到的是空壳页面；部署监控无法区分“UI 正常”与“UI 资源未加载”。

**关闭条件**

- 构建产物损坏时启动或 health endpoint 明确失败；
- fallback 页面使用非 2xx 或带机器可读 `uiAssets=missing` 状态；
- 增加 embedded manifest 损坏、文件缺失、错误 MIME 和 fallback 监控测试。

### F-06 [P2] 后台 reconcile 对配置读取失败静默降级

服务器周期任务把 `bb.config.load()` 的异常转换为 `null`，随后仍然尝试 drain 通知队列：[server.ts:126](../packages/workbench/src/ui/server.ts#L126)。异常不会进入 `reconcileFailures`，也没有单独的配置损坏事件。

**关闭条件**

- 构造损坏 `workbench.yaml` 的隔离现场；
- 证明 `/api/state`、日志、事件和通知队列都能区分 config unreadable 与“没有通知”；
- 选择 fail-closed（停止 drain）或显式使用默认配置，但必须留证。

### F-07 [P2] 路由测试覆盖了未接线能力，不能代表产品路径

`workspace-routes.ts` 自己注明 `/api/sync`、`/api/dispatch`、`/api/agent/run`、`/api/review` 不是 dashboard 调用的能力；“绿色 route test”不等于面板能 dispatch。[workspace-routes.ts:2](../packages/workbench/src/ui/workspace-routes.ts#L2)

这不是必然的代码 bug，而是测试分类缺陷：路由单测应标为 API contract tests，产品验收必须有实际浏览器调用或明确记录为非产品表面。

## 4. 产品读数与状态假阳性

当前 `stats --json` 的关键读数仍是：

- `threads.footprintCoverage=0.7333`；
- `lifecycle.resumeNotesConsumed=0`；
- `landmarkReviews.current.reviewed=0`；
- `premises.verdict=too-quiet`，通知/重叠约 `0.3%`；
- seal decisions 有记录，但当前可见记录均为 `pass`、`hit=false`、`blocked=0`、`reviews=0`。

这些数据不能被“测试全绿”覆盖。阶段 4 的真人窗口和正式发行已由 [ADR-0019](decisions/0019-phase4-and-release-acceptance-as-external-gates.md#L19) 明确移为外部门；Task Forest 的 `done/deprecated` 只代表工程计划口径已收敛，不代表用户价值已证实。

## 5. 分阶段整改计划

### 阶段 A：先修验收控制面（P0/P1）

目标：让红灯真的能出现，且每个绿灯对应真实路径。

- 修正 provider dropdown 断言，统一从能力表生成选项期望；
- 将 Playwright 安装、启动后端、隔离 workspace、报告归档纳入 JihuLab；
- 清理关键 E2E 的无条件/条件 skip，缺前置数据时 fail with reason；
- 为所有写 API 增加 malformed JSON / schema / no-side-effect 反例；
- 为 UI asset manifest 增加损坏/缺失资源失败测试；
- 把 route contract、browser E2E、real-provider E2E 分成三种报告，不再合并成一个“UI green”。

**阶段出口**：Playwright 至少能真实执行；F-01、F-04、F-05 的反例先红后绿；CI 报告中 `skipped=0`（或有明确允许清单）。

### 阶段 B：修复生产路径的可观测失败（P1/P2）

- 决定 config unreadable 的 fail-closed 语义并补隔离现场；
- 对后台 reconcile、通知 drain、embedded assets、线程恢复统一记录错误身份；
- 反馈和恢复类 API 使用 schema，禁止任意 payload 直接写事件；
- 为每个“catch 后继续”的生产路径建立审计表：错误是否可见、是否改变状态、是否可重试、是否产生事件。

**阶段出口**：每条异常路径都有状态不变量和持久化证据；`doctor`、`/api/state`、日志不会把损坏伪装成空/零/健康。

### 阶段 C：Codex 真实写侧验收（P1）

- 使用真实 Codex CLI，而不是 fake app-server；
- 采集 read、write、approval、失败、取消、进程重启五类会话；
- 对 stale premise、readonly area、正常写入分别验证；
- 检查 `commandActions[].path`、generated footprint、seal decision、thread final state 是否同一回合可关联；
- 若仍不接 seal，更新 README、能力矩阵和 UI 提示，不再称为“与 Claude 等价”。

**阶段出口**：至少一条真实写入链有独立日志、事件序列和复现命令；否则 Codex 保持 experimental/limited 标记。

### 阶段 D：发布与跨平台一致性（P1）

- 以当前验收 HEAD 重新生成四平台资产；
- 在至少一个非 Windows 宿主执行 Linux/macOS 之一；
- 下载 Release 资产后运行独立 smoke，不使用 workspace `dist`；
- 固定源码 commit、tag、资产 digest、测试报告、平台执行结果；
- 更新 `CHANGELOG`，消除 `Unreleased` 与公开版本的歧义。

**阶段出口**：公开下载物与审计 HEAD 可追溯，且平台声明与实际运行证据一致。

### 阶段 E：真人价值窗口（外部门）

- 使用真实项目和真实人类操作，不使用脚本租户或 agent 代答；
- 产生至少一次真实 seal 冲突/复核、恢复卡消费和地标 review；
- 重新计算 `stats` 与 fit ledger；
- `too-quiet` 必须解释为谓词过严、来源缺失或真实低通知率之一，并保留原始证据。

**阶段出口**：只能报告“方向性支持/反对/证据不足”，不能用工程测试替代真人数据。

## 6. 建议的验收命令包

```text
bun run typecheck
bun run lint
bun run test:workbench
bun run test:workbench-ui
bun run test:context-rot
bun run build:ui
cd packages/workbench && bun run build && bun run test:build && bun run build:all
node scripts/check-forest-landing.mjs
python C:/Users/27933/.workbuddy/skills/task-forest/scripts/task_forest.py validate --workspace D:/helmor-main
cd apps/workbench-ui && bun run test:e2e
```

另外必须保存：

- 每条命令的 exit code、pass/fail/skip 数和耗时；
- 浏览器 trace/screenshot；
- 二进制 SHA256 与来源 commit；
- Codex/Claude 真实会话的原始事件、足迹和最终线程状态；
- `stats --json`、`doctor --json`、fit ledger 和当前工作树状态。

## 7. 结论与停止条件

当前不应把项目标记为“全部缺陷已解决”。下一轮应先完成阶段 A，再决定是否进入 Codex 写侧和发布验收。任何报告若没有浏览器、真实 provider、当前发布物和真人 fit 证据，只能使用“工程门通过/产品证据不足”的双标签。

本文件本身不改变 Task Forest 状态；若要把阶段 A–E 建成正式任务节点，应另走 proposal-save → 用户确认 → proposal-apply → validate/export/check-landing 流程。
