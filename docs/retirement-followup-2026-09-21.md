# 退役后续：远端验收与技能统一（2026-09-21）

本轮按用户确认的建议推进，承接 [本地退役验收](retirement-closeout-validation-2026-09-21.md)。

## 远端验收

原有 6 个提交已推送至 `codex/retirement-closeout-20260921`，建立
[PR #28](https://github.com/Baixu22/VerseSpace/pull/28)。首轮 CI 对应
`9b8bb20874a605a16e09536c623d850cef623fb7`，
[运行 35560280554](https://github.com/Baixu22/VerseSpace/actions/runs/35560280554)
未启动任何步骤。GitHub 的失败注释为：

> The job was not started because recent account payments have failed or your spending limit needs to be increased.

用户已明确选择“暂时无法恢复，保留 PR 等待 CI”。因此不合入 main、不创建发布 tag；
恢复后应针对 PR 最新提交重跑完整检查，再合入。此阻塞独立于已通过的本地构建与测试。

## 任务森林技能统一

保留原先指定的 `~/.workbuddy/skills/task-forest` 为唯一权威目录；
`~/.codex/skills/task-forest` 已改为指向它的 Windows junction，Claude 原入口
通过 Codex junction 指向同一目录。旧 Codex 副本保存在
`~/.codex/skill-backups/task-forest-before-unify-20260921`，两份原始副本也保留在本轮本地证据目录。

比较实际行为后合并了双方能力：

- 保留 WorkBuddy 的排序、单 HTML 导出、未展示阻塞计数和默认关闭全局 registry。
- 补入 Codex 的陈旧快照编号保护、快照图哈希、废弃子节点进度排除与 LF 写入。
- 合并锁快照复核、损坏锁恢复和宿主禁止 unlink 时的释放方式。
  创建与接管空锁使用系统文件锁串行写入，修复非空锁接管的句柄泄漏；
  不清理已确认存活的持锁者。
- 保留并运行历史回归，增加 8 个进程、160 次写入且 unlink 被拒绝的实际竞争检查。

合并前，旧权威副本在补入的历史回归中暴露了快照覆盖、缺少图哈希和废弃节点
拖低进度三个问题；修复后历史 5 项、锁恢复、160 次并发写入、完整导出回归与技能
结构检查全部通过。本仓库 `validate` 通过；三个入口的主脚本 SHA256 一致：
`ff02745282619a55ff96ed2a2a96266e816b56d7b723a0a061ffefc25e6cab2f`。

本轮工具变更位于机器级技能目录，Workbench 产品源码未增加新依赖。
前序 `.workbuddy/_*.txt` 材料继续保留，待远端验收后再清理。

## 历史阻塞复核

TF-0173 取得新 Git 崩溃转储，并复现旧宿主切分支时的静默文件损坏。
具体证据、已确认范围和剩余条件见 [Git 故障复核](git-crash-followup-2026-09-21.md)。
该节点没有被虚报为已修复。
