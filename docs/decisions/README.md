# 架构决策记录（ADR）

VerseSpace/Workbench 的重大技术决策以 ADR 形式记录在本目录：一个决策一个文件，编号递增、只增不改；推翻旧决策时新增一条并标注取代关系。

每份 ADR 与仓库任务森林（`.agent-workbench/task-forest/`，可读导出 `exports/task-forest.html`）中的决策节点一一对应，规划与执行的权威进度以任务森林为准。

| 编号 | 决策 | 状态 | 森林节点 |
| --- | --- | --- | --- |
| [0001](./0001-runtime-bun-typescript.md) | 运行时 = Bun 1.3 + TypeScript | 已接受 | TF-0013 |
| [0002](./0002-package-location.md) | 包落位 = packages/workbench（bun workspace 成员） | 已接受 | TF-0014 |
| [0003](./0003-helmor-legacy-freeze.md) | Helmor 存量处置 = MVP 期间冻结，v0.1.0 后再评估退役 | 已接受 | TF-0015（后继节点 TF-0055） |
| [0004](./0004-foundation-strategy.md) | 基座策略 = 核心自研 + 组件级借库，不整体 fork | 已接受 | TF-0016 |
| [0005](./0005-local-web-ui.md) | Workbench 增加本地 Web GUI（`workbench ui`），取代 ADR-0004 的 no-web-server 约束 | 已接受 | 森林 GUI 节点 |
| [0006](./0006-advisory-concurrency-control.md) | 并发控制采用建议式（advisory），拒绝 single-writer 排他 | 由 ADR-0010 收敛 | TF-0138 |
| [0007](./0007-monotonicity-first.md) | 单调优先：与其协调，不如把操作改造成不需要协调（CALM） | 由 ADR-0010 收敛 | TF-0138 |
| [0008](./0008-structure-from-execution.md) | 结构从执行推导，不从对话推断；交互层只做加法 | 由 ADR-0010 收敛 | TF-0138 |
| [0009](./0009-proposal-ask-costs.md) | 实测 B/C/K：提议区间为空，不建「要不要 X」式提议 UI，以廉价撤销替代 | 已裁决 | TF-0091 |
| [0010](./0010-premise-custody.md) | 前提守护架构与产品边界：一条日志、两类事实、三个投影；禁内容级合并；继承以文件级复刻为准 | 已接受 | TF-0138 |
| [0011](./0011-legacy-retention.md) | v0.1.0 后保留三块存量，按实际引用抽取，主题仍复用 | 已接受 | TF-0055 |
| [0012](./0012-gui-write-endpoint-admission.md) | GUI 写操作端点准入：四条判据逐端点收口 ADR-0005 的「后续逐个评估」；线程删除为唯一不可撤销操作，附条件准入 | 已接受 | TF-0174 |
| [0013](./0013-workbench-identity-and-compliance.md) | 主线身份 = 保留 monorepo + 改名 + 翻转叙事；合规三件一次做完；sidecar 触发条件 = 第二个需观测足迹的 provider；退役条件 = 四项容器耦合清零 | 已接受（决策 3 的接入形态由 ADR-0017 取代） | TF-0187（阶段 TF-0183） |
| [0014](./0014-legacy-retirement-gate.md) | 存量退役闸门核查 = 四项耦合清零（已满足）；删除支线外围 apps/marketing 与 apps/registry；三块存量暂保留为行为参考 | 已接受 | TF-0218 / TF-0219（阶段 TF-0213） |
| [0015](./0015-legacy-retirement-execution.md) | 执行存量退役：流夹具迁入主线、清理构建与发布引用、删除三块旧实现 | 已接受 | TF-0225 / TF-0226（归属 TF-0219） |
| [0016](./0016-retirement-closeout.md) | 退役收口：修复干净安装的字体依赖、增加 UI 构建门禁、更新归属与首页、纠正任务依赖 | 已接受 | TF-0225 / TF-0226（上级 TF-0176） |
| [0017](./0017-second-observable-provider-integration.md) | 第二个可观测 provider 接入形态 = 直接监督外部 CLI + 主包内轻量协议适配，不复活 sidecar、不 import SDK；取代 ADR-0013 决策 3；首个落地 = codex；交互协议只接权限请求进账本 | 已接受（写侧「seal 不在这条车道上」一句由 ADR-0023 取代） | TF-0246（阶段 TF-0245，目标 TF-0232） |
| [0018](./0018-single-ci-channel-jihulab.md) | CI 单一通道 = JihuLab（极狐）；删除 GitHub Actions 车道与 `release-workbench.yml`、不再使用 gitlab.com；取代 ADR-0015 中「保留 release-workbench.yml」一句 | **已被 ADR-0021 取代**（极狐通道一并退役） | TF-0232（已 done） |
| [0019](./0019-phase4-and-release-acceptance-as-external-gates.md) | 阶段 4（人工使用窗口）与发行验收转为常设外部门、不作为本轮交付；发行以「编译版本 + GitHub Release + 社区面」为准；据 TF-0232 验收的第二条路收口 | 已接受 | TF-0232（据此收口） |
| [0020](./0020-relay-handoff-upload-surface.md) | 接力交接的上传面定性 = 只上传结果性产物且换机可复现；四类别 + 双向门禁 + `docs/handoff/` 目录白名单；收紧 TF-0220「原始数据本地留，精选读数入库」 | 已接受 | TF-0268（done） |
| [0021](./0021-retire-all-ci-channels.md) | 退役全部 CI 通道：删 `.gitlab-ci.yml` 与极狐快照脚本、停本机 runner；门禁改由本机命令给出、发行改走本机；**取代 ADR-0018** | 已接受 | 本轮（2026-09-26） |
| [0022](./0022-claim-status-semantics.md) | 声明状态语义：`done` 必须指向读数（直接/覆盖两级，覆盖须写明「间接」）；无读数覆盖 → `review_needed`；交付物不存在 → `deprecated`；仪器退役的读数只能当观测；读数 stale ≠ 节点未完成 | 已接受 | TF-0278（阶段 TF-0277） |
| [0023](./0023-research-prototype-closeout.md) | 按工程研究原型收尾：固定核心声明、Codex 实验通道边界、上传面引用裁决；冻结功能扩展；**取代 ADR-0017 关于 Codex 审批不咨询封印的现行描述** | 已接受 | 本轮（2026-09-26） |
