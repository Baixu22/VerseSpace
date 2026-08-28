# 架构决策记录（ADR）

VerseSpace/Workbench 的重大技术决策以 ADR 形式记录在本目录：一个决策一个文件，编号递增、只增不改；推翻旧决策时新增一条并标注取代关系。

| 编号 | 决策 | 状态 |
| --- | --- | --- |
| [0001](./0001-runtime-bun-typescript.md) | 运行时 = Bun 1.3 + TypeScript | 已接受 |
| [0002](./0002-package-location.md) | 包落位 = packages/workbench（bun workspace 成员） | 已接受 |
| [0003](./0003-helmor-legacy-freeze.md) | Helmor 存量处置 = MVP 期间冻结，v0.1.0 后再评估退役 | 已接受 |
| [0004](./0004-foundation-strategy.md) | 基座策略 = 核心自研 + 组件级借库，不整体 fork | 已接受 |
