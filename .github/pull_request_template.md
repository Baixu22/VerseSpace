## 做了什么

<!-- 一两句话说明这个 PR 交付了什么。 -->

## 为什么

<!-- 它解决什么问题 / 服务哪个目标。架构类改动请指向对应 ADR。 -->

## 验证

<!-- 勾选你实际跑过的，并贴关键读数。不要勾没跑过的。 -->

- [ ] `bun run typecheck`
- [ ] `bun run lint`
- [ ] `bun run test`（三套：workbench → workbench-ui → context-rot）
- [ ] 改动涉及 `packages/context-rot/**` 时，workbench 与 context-rot **两套**都跑过
- [ ] 涉及界面时，`bun run build:ui` 通过
- [ ] 涉及构建产物时，`cd packages/workbench && bun run test:build` 通过

## CI

**GitHub 上没有状态检查**（[ADR-0018](../docs/decisions/0018-single-ci-channel-jihulab.md)：CI 只剩 JihuLab）。请贴 JihuLab 流水线链接或 runner 日志读数，否则这个 PR 等于没跑过 CI。

- JihuLab 流水线：

## 检查清单

- [ ] 新增/修改的命令都支持 `--json`
- [ ] 没有新增超过约 300 行的单文件（超了就拆模块）
- [ ] 图标只从 `@/components/icon` 导入；字号用语义 token
- [ ] 账本能力只以对话内既有形态出现（消息 part / sidecar / 工具卡），没有新增独立面板或路由级视图
- [ ] 没有重新引入 Tauri / Rust / sidecar
- [ ] 推 tag 或改版本号（真实发布动作）——若是，已确认版本号与 `CHANGELOG.md`
- [ ] 重大决策已写成 ADR 并更新 `docs/decisions/README.md`
