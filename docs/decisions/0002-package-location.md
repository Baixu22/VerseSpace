# ADR-0002：包落位 = packages/workbench（bun workspace 成员）

- 状态：已接受
- 日期：2026-08-28

## 背景

根 package.json 的 workspaces 为 `[".", "apps/*", "packages/*"]`，其中 `packages/` 目前为空目录。仓库内已有两种包集成先例：`apps/*`（workspace 成员）与 `sidecar/`（刻意不在 workspace 内，自带独立 lockfile）。

## 决策

Workbench CLI 落位为 `packages/workbench`，作为 bun workspace 成员；biome 的 `**` 通配自动覆盖、lint-staged 自动生效，无需改任何配置。

## 理由

- Workbench 是本仓库的主线新架构而非附属进程，纳入 workspace 后根脚本（test/typecheck 链）、changesets 与 CI 车道可以统一管理。
- 与 sidecar 的「完全隔离」模式相比，主线包共享根工具链更省心；sidecar 模式保留给需要锁定依赖树的真实独立进程。

## 后果

- 正面：`bun install` 一条命令装齐；CI 可按 `packages/workbench/**` 过滤出独立车道。
- 负面：根 bun.lock 会包含 workbench 依赖；发布前在 `.changeset/config.json` 的 ignore 中挂起（里程碑十一处理发布时移除）。
