# ADR-0014：存量退役闸门核查与支线外围目录删除

- 状态：已接受（2026-09-19）
- 森林节点：TF-0218（删除 `apps/marketing` 与 `apps/registry`）、TF-0219（退役闸门核查）；归属阶段 7 `TF-0213`，上级目标 `TF-0176`
- 补充/兑现：ADR-0013 决策 6 预留的「退役闸门另立 ADR-0014（尚未撰写）」
- 相关：[吸收分析报告](https://github.com/Baixu22/VerseSpace/blob/799f89cd94ce774458e70c822bf116350d73fcb6/docs/helmor-absorption-deep-exploration-2026-09-17.md)、ADR-0013、ADR-0011、ADR-0003

## 背景

ADR-0013 把存量退役条件定义为**四项容器引用清零**（CSS import、图标生成、postinstall、pre-commit），满足后另立 ADR-0014 决定删除 `src/`、`src-tauri/`、`sidecar/`。本 ADR 兑现该预留，并先执行第一步：删除支线外围 `apps/marketing`（官网）与 `apps/registry`（手机配对服务）。

## 决策 1：删除 `apps/marketing` 与 `apps/registry`（已执行）

两个目录是支线外围（官网与手机配对服务），与主线产品无代码级依赖。删除前按 ADR-0011 核查了全部引用并同步清理：

| 引用位置 | 处置 |
| --- | --- |
| `.github/workflows/refresh-marketing.yml` | 整个 workflow 关于官网 ISR 再验证，**删除文件** |
| `.github/workflows/publish.yml` `notify-marketing` job | 移除该 job（含 `HELMOR_MARKETING_REVALIDATE_SECRET` 引用） |
| `.github/workflows/ci.yml` 注释 | 移除「marketing-only PR」表述 |
| `.github/workflows/release-plan.yml` 注释 | 移除 `apps/marketing` 进入 workspace 的历史解释 |
| `.changeset/config.json` `ignore` | 移除 `@helmor/marketing`（置空） |
| `.claude/launch.json` | 移除 `marketing` 启动配置 |

核查结果：仓库内已无对 `apps/marketing`、`apps/registry`、`@helmor/marketing`、`@helmor/registry`、`refresh-marketing`、`notify-marketing` 的残留引用（剩余命中仅在本地被忽略的 `.claude/worktrees/` 快照里）。`apps/` 下现只剩 `workbench-ui`。

## 决策 2：四项容器耦合清零核查（闸门满足）

| 耦合项 | 处置节点 | 证据 |
| --- | --- | --- |
| CSS import（耦合之一） | TF-0184 | `apps/workbench-ui` 内联 `src/styles/color-theme.css` 的 Base token 子集，断掉全仓唯一跨目录 import；`apps/workbench-ui/src/index.css` 不再 `@import` `src/` |
| 图标生成（耦合之二） | TF-0216 | `scripts/gen-icon-layer.mjs --target workbench-ui` 只生成 UI 图标层；实测后 `git status` 不含 `src/`（映射表仍单一来源） |
| postinstall（耦合之三） | TF-0214 | 根 `postinstall` 移除 `cd sidecar && bun install`；主线 `bun install` 不再拉 agent SDK；支线改用 `bun run install:legacy` |
| pre-commit（耦合之四） | TF-0215 | lint-staged 的 Rust 车道限定 `src-tauri/**/*.rs`；仅改 `packages/` 或 `apps/workbench-ui` 的提交不触发 cargo |

四项全部清零，ADR-0013 定义的退役条件**满足**。

## 决策 3：`src/`、`src-tauri/`、`sidecar/` 的去留

四项耦合清零后，三块存量**具备删除条件**。但本 ADR 决定**暂不执行删除**，保留为冻结的行为参考（延续 ADR-0003 / ADR-0011）：

- `src-tauri/tests/fixtures/streams/` 与 `sidecar/` 仍是主线 Claude 事件形状的**真实参考样本**（阶段 5 的 fixture 回放、TF-0205/0206 的协议契约都从那里来）；
- CI 的 `rust` / `sidecar` 车道仍运行（`bun run test` 六套件含 Rust），删除三块需要先移除 CI 与根测试脚本对它们的引用，再跑三套门禁（`bun install` / typecheck / test）——这是一个独立执行轮，不在本 ADR 内伪造「已删除」。

**退役条件已满足的事实由本 ADR 固化**；删除动作作为后续执行项，由任务森林跟踪（`TF-0219` 的核查结论即本 ADR）。