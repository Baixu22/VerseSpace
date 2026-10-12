# Arena 分支合并 + 接力：线程头展示切换与缓存读数（2026-10-12）

**标签**：工程门（本机单测、类型检查、门禁脚本）。**产品证据：无**——本轮不接真实 provider，
缓存命中率与切换提示都由假 provider / 构造数据驱动，不代表线上行为。

## 1. 合并

把 `origin/arena/50b44ce0-versespace` 合入 `main`。该分支正好比 `main`（`a40f7ee`）领先 4 个
提交、无分叉（merge-base = `main` HEAD），用 `--no-ff` 保留合并提交与作者归属。

| 提交 | 内容 |
| --- | --- |
| `027cf38` | 上游协议层适配调研（只读，无运行改动） |
| `9cd1426` | 上游模型适配、失败转移、线程缓存键（HTTP 通道） |
| `a8e2c6c` | 协议 codec、失败分类、目标冷却、缓存 usage |
| `5efcc25` | 会话绑定、跨协议分叉、长会话 Anthropic 1h TTL |

合并本身无冲突。合并后 `main` 领先 `origin/main` 5 个提交（4 + 合并提交）。

## 2. 本轮接力改动

上一轮交接（`2026-10-12-upstream-stability-phase2.md`）把「界面展示已切换到 X」列为**首要项**，
并指出 `lastRun` 的 `attempts` / `switchedFrom` / `usage` 已落盘但**没有任何渲染**。本轮补上：

| 文件 | 改动 |
| --- | --- |
| `apps/workbench-ui/src/chat/message-types.ts` | `ThreadMeta.lastRun` 补齐 `attempts` / `switchedFrom` / `usage`，与服务端 `ThreadLastRun` 对齐（此前 UI 类型把这些字段丢掉了） |
| `apps/workbench-ui/src/components/chat/thread-observability.tsx` | 线程头新增两个诚实标注：`switchedFrom` 有值时显示「已切换 · <实际 provider> · N 次尝试」；provider 上报 usage 时显示「缓存命中 X%」 |
| `apps/workbench-ui/src/components/chat/thread-observability.test.tsx` | 新增 2 个用例覆盖上述两条 |

设计口径：
- **不猜**。usage 缺失（上游没返回）就不渲染，不把缺失当成 0 命中率。
- **区分「本轮切换」与「线程绑定」**。提示文案写明「这只是本轮的事实，线程绑定仍是主目标」，
  避免把兜底应答误读成线程换了协议（协议切换走的是分叉，见阶段二文档）。
- 沿用既有的 `data-testid` + Tooltip 模式，无分歧时不渲染（无切换、无缓存、读集可观测、继承完整）。

## 3. 证据读数（本机实测）

| 命令 | 结果 | exit |
| --- | --- | --- |
| `bun run typecheck` | 三个包全过 | 0 |
| `bun run test:workbench`（`packages/workbench` 全量） | 1167 pass / 0 fail（185 文件，203.66s） | 0 |
| `bun test src/chat` | 407 pass / 0 fail（57 文件） | 0 |
| `apps/workbench-ui` `vitest run` | 71 pass / 0 fail（19 文件；改动前 69） | 0 |
| `bun run check:upload-surface` | 0 violations，12 条 referenced-but-local 已裁决 | 0 |
| `bun run lint` | **3 errors（既有，非本轮引入）** | 1 |
| `bun run check:claims` | 16/19 一致；3 条 stale（见下） | 1 |
| `bun run test:build`（两个构建形态） | native/js 均 `initialized·doctor·stats·headlessUi·bundledUi = true` | 0 |
| `bun run test:upload-surface`（分类器+链接） | 31 pass / 0 fail | 0 |
| `pwsh -NoProfile -File scripts/win/e2e-browser.ps1` | **不稳定**：两次分别 7 fail / 4 fail，失败项每次都不同 | 1 |

- 本机无 child-process 沙箱限制：`bun test` 能正常 spawn git/supervisor，故上表 workbench 全量是真实读数。
- **E2E 不稳定是环境问题，不是本轮回归**：失败全部是 `ERR_CONNECTION_REFUSED`——Vite dev server
  在内存压力下中途退出（本机 87 个 node 进程、约 3.9 GB 可用内存，对应 AGENTS.md 的 16 GB 并发告警）。
  两次运行的失败集合不同（7 fail vs 4 fail），且 e2e spec 与 composer 自上次 14/0 读数以来无改动。
- `lint` 的 3 个错误（`evidence/claims.json`、`scripts/upload-surface/policy.json`、
  `scripts/upload-surface/classify.test.mjs` 的换行格式）在**合并前的基线 `a40f7ee` 上同样存在**
  （已用 `git stash` + detached checkout 复核），不是本次合并引入的回归。
- `check:claims` 的 stale 是因为 arena 的 4 个提交改动了多条声明的 `subject_paths`
  （ADR-0022：读数失效即重取，不能当作没发生）。按 ADR-0022「失效即重取」，本轮把合并触及的读数逐条重跑
  （`record-reading.mjs --run`，真实退出码），16/19 现在 valid。剩 3 条**故意保持 stale**：
  `claim-lint`（3 个既有 CRLF 格式错误）、`claim-browser-e2e`（见下）、`claim-codex-native-seal`
  （需要真实 Codex CLI 会话）。

## 4. 刻意没做什么

- **没有实现 rebind（同协议换模型/端点）的 UI 提示**。事件 `thread.binding_changed` 已写入线程日志，
  但线程事件没有走 `ThreadMeta` 暴露给前端，渲染它需要新的读路径，超出本轮「首要项」的最小改动面。
- **没有引入 IR / Gemini 原生协议**。与上一轮判断一致：历史目前是纯文本，等工具调用与推理块进入
  HTTP 通道再做。
- **没有动服务端逻辑**。本轮只补 UI 类型与渲染；`lastRun` 的写入路径在 arena 提交里已完备。
- **没有为了变绿而手改 claims**。无法在本机真实跑出的仪器（浏览器 E2E、真实 Codex CLI）
  保持 stale，不伪造读数。

## 5. 下一步与遗留风险

1. **rebind 提示**：把 `thread.binding_changed` 事件投影进线程视图，与「已切换」提示并列。
2. **缓存节省仍是理论值**：本轮只让命中率可见，仓库里仍没有真实线上缓存数据。
3. **熔断/适配记忆仍在内存**：重启即清空，不跨实例。
4. **跨协议分叉后回到原协议**需要用户手动切配置，无「回到源协议」手势。

## 6. 复核命令

```bash
cd packages/workbench && bunx tsc --noEmit
cd ../../apps/workbench-ui && bunx vitest run src/components/chat/thread-observability.test.tsx
cd ../../ && bun run typecheck
NO_PROXY="127.0.0.1,localhost,::1" bun run test:workbench-ui
```
