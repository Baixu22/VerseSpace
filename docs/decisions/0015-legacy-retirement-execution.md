# ADR-0015：存量退役执行——夹具迁入主线、引用清零、删除 `src/`、`src-tauri/`、`sidecar/`

- 状态：已接受（2026-09-21）
- 森林节点：TF-0225（执行轮）、TF-0226（夹具迁移）；归属 TF-0219 / ADR-0014 决策 3，上级目标 TF-0176
- 补充/兑现：ADR-0014 决策 3 预留的「删除动作作为后续执行项，由任务森林跟踪」
- 相关：[ADR-0014](0014-legacy-retirement-gate.md)、[ADR-0013](0013-workbench-identity-and-compliance.md)、[ADR-0011](0011-legacy-retention.md)、[ADR-0003](0003-helmor-legacy-freeze.md)

## 背景

ADR-0014 决策 2 判定**四项容器耦合清零**（CSS import / 图标生成 / postinstall / pre-commit），
决策 3 据此认定 `src/`、`src-tauri/`、`sidecar/` **具备删除条件**，但当时**不执行删除**，
理由是三块里还留着主线的**真实参考样本**：

> `src-tauri/tests/fixtures/streams/` 与 `sidecar/` 仍是主线 Claude 事件形状的真实参考样本
> （阶段 5 的 fixture 回放、TF-0205/0206 的协议契约都从那里来）

本 ADR 兑现该预留：先把参考样本搬进主线，再清引用，最后删除三块。

## 决策 1：流夹具迁入主线（已执行）

`src-tauri/tests/fixtures/streams/` 下 49 个 `.jsonl` 夹具（claude 19 / codex 11 /
cursor 7 / kimi 3 / opencode 9，共 766 KB）**整体迁入**
`packages/workbench/src/chat/fixtures/streams/`，与它们的消费者放在同一个包里。

| 项 | 迁移前 | 迁移后 |
| --- | --- | --- |
| claude 夹具消费者 | `packages/workbench/src/chat/claude-fixtures.test.ts` 用相对路径 `../../../../src-tauri/tests/fixtures/streams/claude` 跨目录读取 | `join(import.meta.dir, "fixtures/streams/claude")`，同包内 |
| 其余 4 个 provider | 只有支线 Rust 测试 `src-tauri/tests/pipeline_streams.rs` 消费 | 保留为**参考样本**（主线尚无对应车道；它们记录的是各 provider 的真实线协议形状） |

**为什么连没有消费者的 4 个 provider 也搬**：它们正是 ADR-0014 决策 3 说的「真实参考样本」——
线协议形状不能靠回忆重建。删掉 `src-tauri/` 后若不留存，这些形状就只剩 git 历史可查。

**核实读数（2026-09-21 本轮实跑）**：迁移后 `bun test src/chat/claude-fixtures.test.ts`
→ **2 pass / 0 fail / 20 snapshots / 547 expect()，184 ms**（迁移前同一用例要跨目录读盘）。

## 决策 2：引用清零清单（ADR-0011 要求的删前重新核查）

删除任一目录前须重新核查样式、构建、发布与 CI 引用。本次核查结果：

| 引用面 | 处置 |
| --- | --- |
| 根 `package.json` scripts | 删 `dev` / `dev:prepare*` / `dev:analyze` / `build` / `preview` / `tauri` / `test:frontend*` / `test:sidecar*` / `test:rust*` / `test:e2e*` / `dev:e2e` / `test:watch` / `dev:cli*` / `install:legacy` / `storybook*` / 全部 legacy `release:*`；保留并改写主线脚本（见决策 3） |
| 根 `package.json` `lint-staged` | 删 `src-tauri/**/*.rs` 车道（Rust 车道随 crate 一起消失） |
| 根 `package.json` deps/devDeps | 删除仅服务于 `src/`（legacy 前端）的全部运行时依赖；测试/构建工具移入真正使用它们的包（见决策 4） |
| `.github/workflows/ci.yml` | 删 `clippy` / `frontend-test` / `sidecar-test` / `rust-test` / `e2e-test` / `app-build` / `storybook-build` / `windows-sidecar-test` / `windows-rust-test` 九个 job 与对应路径过滤器 |
| `.github/workflows/publish.yml` | **删除**（legacy Helmor 的 DMG/NSIS/updater 发版链） |
| `.github/workflows/release-plan.yml` | **删除**（changesets 流程产出 `v<version>` 标签，专为触发 publish.yml） |
| `.github/workflows/updater-dry-run.yml` | **删除**（校验 Tauri updater manifest） |
| `.github/workflows/release-workbench.yml` | **保留**（主线发版链，`workbench-v*` 标签 + 四目标矩阵） |
| `.github/actions/{build-sidecar,cache-bundle-archives,setup-rust-tauri}` | **删除**；保留 `setup-js` |
| `.husky/pre-commit` | 只留 biome 车道（lint-staged 配置里 Rust 车道已删） |
| `biome.json` | 删 `!src-tauri/gen`、`!src-tauri/target` 两条排除与 reicon 的 legacy 路径 override |
| `tsconfig.json` / `tsconfig.node.json` | **删除**（前者 include `src`，后者 include 三个 legacy 构建配置） |
| `scripts/` | 删 legacy 14 项（`build-platform.*`、`prepare-sidecar.mjs`、`stage-dev-cli.mjs`、`verify-bundled-cli.sh`、`release-local-macos.sh`、`*-macos-signing.sh`、`win/`、`create-release-tag.mjs`、`extract-release-notes.mjs`、`sync-release-versions.mjs`、`verify-release-config.mjs`、`consume-release-announcements.ts`、`verify-release-announcements.ts`）；保留 `gen-icon-layer.mjs`（参数化到 workbench-ui）、`tag-workbench-release.mjs`、`git-ref-repair.sh`、`reicon-mcp.mjs` |
| 根 `index.html` / `vite.config.ts` / `vite.e2e.config.ts` / `playwright.config.ts` / `components.json` / `vitest.shims.d.ts` / `public/` / `e2e/` / `.storybook/` / `helmor.json` | **删除**（legacy 前端的构建与测试入口） |
| `flake.nix` / `flake.lock` / `.envrc` / `NIX_SETUP.md` | **删除**（Rust/Tauri 开发 shell） |
| `.vscode/extensions.json` | 删 Tauri/Rust 推荐（保留通用项） |
| `.changeset/` + `changeset` 脚本 + `@changesets/*` | **删除**（主线发版走 `workbench-v*` 标签，不用 changesets） |

## 决策 3：主线的脚本地表（删除后的根 `package.json` scripts）

只留三块能力：**三个包的门禁**、**UI 开发/构建**、**workbench 发版**。

```
typecheck           三包串联（workbench / context-rot / workbench-ui）
lint / lint:fix     只跑 biome（Rust 车道随 crate 消失）
test                三包测试串联
test:workbench      与 test:workbench-ui / test:context-rot
dev:ui / build:ui   workbench-ui 开发与构建（含 ui-prepare 嵌入）
icons               生成 workbench-ui 图标层
release:tag:workbench
```

`test` 从六套件降到**三套件**——被删的三套（frontend / sidecar / rust）测的是已删代码。

## 决策 4：测试与构建工具随消费者走

根 `package.json` 里那些**不是 legacy 专用**的工具（`vitest` / `jsdom` /
`@testing-library/*` / `@tailwindcss/vite` / `@playwright/test`）此前靠 workspace 提升
被 `apps/workbench-ui` 隐式使用。根依赖清空后它们必须**显式声明在消费者身上**，
否则 `apps/workbench-ui` 的 `vitest run` 会静默失去测试环境。

## 后果

- 主线不再有任何指向 `src/`、`src-tauri/`、`sidecar/` 的引用；三块存量删除。
- 被删代码的**形状**（线协议夹具、事件协议注释）在主线内保留为夹具与 ADR 记录；
  完整历史仍可 `git show` 取得。
- **不可逆性的边界**：删除只发生在工作树与后续提交中，`git` 历史里三块完整存在
  （`944b9d6` 及更早——即退役落地前的最后一个提交）。要恢复某段实现，从历史里取，
  不要指望工作树。
- 本 ADR **不**声称「主线已独立验证完毕」：六套件测试中的三套随代码一起消失，
  剩下三套的可跑性由执行轮的现场读数回答（见森林节点 TF-0225 的 evidence）。
