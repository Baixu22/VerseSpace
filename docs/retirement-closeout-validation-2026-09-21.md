# 退役收口修复与验收（2026-09-21）

本轮从 `dc3c767` 的干净工作区开始，核查交接记录后修复可复现的问题。
决策见 [ADR-0016](decisions/0016-retirement-closeout.md)。本记录描述本地验收，不代替远端 CI 或跨平台发行验证。

## 修复内容

| 问题 | 根因与修复 |
| --- | --- |
| 干净安装无法构建面板 | CSS 引用 Geist / Geist Mono，但依赖与锁文件被退役清理掉；旧 node_modules 掩盖问题。将原先实际使用的 5.2.9 / 5.2.8 固定在 UI 包，更新锁文件。 |
| 测试不能发现上述构建失败 | tsc 和 jsdom 不解析 CSS 的字体依赖。CI 在面板测试后增加 `bun run build:ui`。 |
| 根 UI 构建执行两次 Vite | 根脚本先构建面板，再调用内部还会构建面板的 `ui-prepare.ts`。改为只调用已有的统一入口。 |
| 发布测试没有沿用包内超时 | 发布 workflow 直接调用 `bun test`，改为 `bun run test:workbench`，沿用现有 60000 ms 配置。 |
| 首页仍以退役产品为主 | 根 README 改为 Workbench 的使用、开发与构建入口；旧介绍保留在 `944b9d6` 及更早的 Git 历史。 |
| 归属声明与实际内容不符 | 根 NOTICE 不再把 Tauri / Agent SDK / Codex CLI 列为当前打包组件；保留上游版权、Apache-2.0 与商标声明。包 NOTICE 补记权限拒绝提示的移植实现和 49 个源代码夹具的来源。 |
| 任务登记错误 | 退役提案改为“删除执行依赖夹具迁移”；补登记两个节点并收口父任务的旧手工进度。 |

只补齐已有消费者所需的两项资产依赖，没有改变 Workbench 的四项运行时依赖、产品边界或许可分类。

## 现场读数

环境：Windows、Bun 1.3.14、Node 24.15.0。HTTP 检查设置
`NO_PROXY=127.0.0.1,localhost,::1`；构建与完整 UI 套件串行运行。

| 检查 | 结果 |
| --- | --- |
| 修复前，仓库外冻结安装 | exit 0；随后 Vite 构建 exit 1：`Can't resolve '@fontsource-variable/geist-mono'` |
| 修复后，同一隔离目录冻结安装 | exit 0，字体版本锁定为 Geist 5.2.9 / Geist Mono 5.2.8 |
| 根 `bun run typecheck` | exit 0，覆盖三个包 |
| 根 `bun run lint` | exit 0，Biome 检查 540 个文件 |
| 根 `bun run test` | exit 0；Workbench 904 pass / 0 fail，UI 61 pass / 0 fail，context-rot 65 pass / 0 fail，共 1030 项 |
| 隔离目录 `bun run build:ui` | exit 0；日志确认 Vite 执行 1 次，嵌入 14 个资源 |
| 隔离目录 Workbench `bun run build` | exit 0；生成本机二进制与 JS bundle，并复制归属文件 |
| 隔离目录 Workbench `bun run test:build` | exit 0；native 与 JS 两种形态均通过初始化、doctor、stats、本地 HTTP 面板和内嵌资源检查 |
| 最终字体版本与本地构建 | 固定回原版本后，UI 61 项测试再次通过；真实工作区包构建 exit 0，dist 已更新 |
| 迁移夹具比对 | 49 个 JSONL 的 Git blob SHA-1 全部与 `944b9d6:src-tauri/tests/fixtures/streams/` 对应文件一致 |
| 归属文件比对 | dist 的 `NOTICE`、`LICENSE`、`LICENSE-APACHE` 与包内文件逐字节一致 |
| Windows Git 文件系统探针 | exit 0；本次宿主未加载 tsbx.dll，兄弟文件保留，嵌套分支与远端引用均写入成功 |
| 任务森林与文档 | proposal-apply / validate / export 均 exit 0；226 个节点，依赖方向正确，原事件前缀与证据保留；导出 HTML 无外部资源，18 个本轮文档链接有效 |

干净目录位于仓库之外，不复制 node_modules；只安装清单和锁文件声明的依赖。
构建副本包含源码、脚本与 `.gitignore`，避免 Tailwind 扫描已生成的 dist。
安装时的 `--ignore-scripts` 只用于该临时副本，避免安装本地 Git hooks；真实工作区已正常执行 `bun install`。

Vite 仍有现有的单个 JS chunk 超过 500 kB 的提示。构建和产物检查均成功；本轮没有调整分包策略。
字体版本最终固定回原版本后，干净安装、根 UI 构建、包构建和双产物检查重新执行，均为 exit 0。

## 任务与边界

修正并应用原提案 `TFP-2026-09-21-legacy-retirement-execution`，保持既有证据数组和历史事件：

- TF-0225：退役执行，done / 100%。
- TF-0226：夹具迁移，done / 100%。
- 依赖：TF-0225 `depends_on` TF-0226。
- TF-0176：done / 100%。应用前已有 14 个直接子节点、48 个后代完成；76.3% 是旧手工快照。
- TF-0173：保持 blocked；缺原始转储、当前未复现，不能据此宣布历史堆损坏已修复。

森林写入沿用保存原提案、支持 `display_order` 的 WorkBuddy task-forest CLI，避免导出回退到旧版排序行为。
没有同步或删除全局技能副本，也没有清理前序会话的临时材料。

本轮不推送 main、不创建发布 tag；未调用真实模型服务，未执行远端 CI 或 macOS/Linux 产物测试。

## 复跑与本地证据

```powershell
$env:NO_PROXY = '127.0.0.1,localhost,::1'
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run test
bun run build:ui
Set-Location packages/workbench
bun run build
bun run test:build
```

若要复核依赖完整性，应在仓库外的新副本运行以上命令，不复用旧 node_modules。
本机原始日志保存在 `.agent-contexts/closeout-retirement-20260921/`（不入 Git）：
`clean-build-before.log`、`clean-install-after.log`、`clean-build-after.log`、
`clean-package-build.log`、`built-smoke.log`、`typecheck.log`、`lint.log`、`tests-final.log`。
任务森林可读导出位于 `.agent-workbench/task-forest/exports/task-forest.html`。
