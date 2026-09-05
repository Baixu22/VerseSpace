# ADR-0011：v0.1.0 后保留 Helmor 存量，按实际引用抽取

- 状态：已接受（2026-09-06 本地节点收口评估）
- 森林节点：TF-0055
- 取代：ADR-0003 中「v0.1.0 后再评估」的延期项；保留其冻结约束

Workbench 包已为 0.3.0，运行在 Bun + 文件系统上，UI 位于 `apps/workbench-ui`。
评估结论是保留存量作为参考和必要共享资源，不整体重写或移除。

| 存量 | 当前关系与证据 | 处理结论 |
| --- | --- | --- |
| `src/` | `apps/workbench-ui/src/index.css` 仍直接导入 `src/styles/color-theme.css`；旧 UI 提供行为参考 | 保留；共享主题继续单一来源。只有删除路径已无实际引用时才考虑移除 |
| `src-tauri/` | Workbench 不导入 Tauri/SQLite；CLI 输出、worktree 生命周期仍是行为参考 | 冻结保留，仅处理必要修复；不迁移旧数据库，不重写 Rust 后端 |
| `sidecar/` | Workbench 使用配置的本地 CLI/HTTP 通道，不导入其 Agent SDK；旧构建和 vendor 固定仍由存量 CI 使用 | 冻结保留，不把 SDK 或捆绑工具链搬入 Workbench |

后续只有出现已验收需求、且现有实现可独立复用时才抽取具体模块；不为未来复用预建共享包。
删除以上任一目录前须重新核查样式、构建、发布与 CI 引用，并另立决策。
本决策不变更根目录安装脚本、旧发行链、用户数据或 git 历史。

验证：Workbench 509 项测试与类型检查通过；源码依赖搜索确认唯一现用的跨目录资源为共享主题 CSS，未引入 Tauri、SQLite 或 sidecar Agent SDK。
