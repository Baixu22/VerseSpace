# ADR-0005：Workbench GUI = 复用仓库 React + Vite + Tailwind + shadcn 栈（`workbench ui`）

- 状态：已接受
- 日期：2026-08-28
- 取代：ADR-0004 中「不引入 Web 服务器」的约束（其余约束不变）

## 背景

《Workbench 实现架构骨架》定位 CLI 工具，并把 Web 服务器标记为「Phase 1-4 不需要，未来可视化时再考虑」。v0.1.0 发行后用户明确需要 GUI。仓库本身（Helmor 基线）就是 Tauri v2 + React 19 + Vite + Tailwind v4 + shadcn/ui（base-nova）的成熟前端栈——首版曾用内嵌 vanilla HTML 实现面板，被正确否决：那是重复造轮子。

## 决策

- **前端**：新工作区应用 `apps/workbench-ui`（Vite + React 19 + Tailwind v4），shadcn 原语按 shadcn 惯例复制进应用（badge/button/separator），主题直接 `@import` 仓库真实的 `src/styles/color-theme.css`（单一来源，零 token 漂移），数据经 TanStack Query 每 2 秒轮询。
- **服务**：`workbench ui` 用 Bun.serve 在 127.0.0.1 提供只读 API（`/api/state`、`/api/sync`、CORS）+ 静态 SPA。资产解析顺序：`--ui-dir` > 编译二进制内嵌资源（Bun `with { type: "file" }` 嵌入，构建时由 `scripts/ui-prepare.ts` 生成清单）> 仓库 dev 构建产物 > API-only 提示页。
- **范围**：GUI 只读 + 一个幂等 sync 按钮；dispatch/review 等有副作用的操作不进 GUI（后续逐个评估）。

## 理由

- 不造轮子：前端栈、主题系统、组件原语全部来自仓库既有资产；新增代码只有视图层与 API 组装。
- 架构定位不变：数据仍只经 Blackboard 读写，UI 是与 CLI 同级的观察面。
- 零新依赖进入核心包：UI 的依赖全在 `apps/workbench-ui`，`workbench` 包只多一个构建期生成清单。

## 后果

- 正面：观察成本大降；主题随仓库演进自动跟随；二进制仍单文件自包含（UI 资源内嵌）。
- 负面：发布构建链多一步 Vite 构建；ADR-0004 的 no-web-server 约束部分失效；写操作端点未来需逐个设闸。
