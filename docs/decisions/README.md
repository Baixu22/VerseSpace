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
