# Issue #6 第二轮收尾

2026-09-14。对照 2026-09-13 完整性报告、用户在 `cbb581d` 上的独立复核和当前源码。
第一轮确认修复 13 项；第 3 项的人答验收、第 8 项的本机旁路不能按“改了说明”算解决。

## 本轮修复

- `70c527a`：修复 `landmark-review-queue.ts --steward` 在真人认可率为 0 时仍宣称 L1 验收通过的问题。
  新回归用例先失败后通过，验证自审不会写入 human 记录，也不会打印真人达标结论；人工通道单独计数。
- 同一提交修复标准前端测试命令收集 `.workbuddy` 旧代码副本的问题，排除本地审计与证据目录。
  原命令曾出现 19 个副本收集失败，项目本身的 1,692 条测试仍通过；修复后仍保留全部 162 个正式测试文件。
- 纠正 `landmark-set.ts` 与投影测量文档中的历史表述：旧答案在新集合上重算，不是独立的新一轮真人复核。
- 恢复 Cargo.lock 校验的原始 `boring-sys2` 4.15.15，951 个归档文件逐字节一致；活跃 registry 的旁路已移除，修改前副本留在本地审计目录。

## 验证记录

以下是本轮实际执行结果，日志位于 `.agent-contexts/issue-6-closeout-2026-09-14/`。

| 验证 | 本轮结果 | 日志 |
| --- | --- | --- |
| 旧前端 | 标准命令通过：162 文件、1,692 项 | `frontend-default.log` |
| sidecar | 418 通过、1 平台相关跳过 | `sidecar.log` |
| Workbench | 106 文件、665 项通过、1 快照通过 | `workbench-final.log` |
| Workbench UI | 9 文件、25 项通过 | `workbench-ui.log` |
| context-rot | 6 文件、65 项通过 | `context-rot.log` |
| 五个 TypeScript 项目 | 全部通过 | `typecheck.log` |
| 根目录 Biome | 1,276 文件通过 | `biome.log` |
| Workbench 原生和 npm 产物 | 构建通过；各自在独立工作区通过 init、doctor、stats、内嵌 UI HTTP 冒烟 | `workbench-build.log`、`workbench-built-smoke.log` |
| context-rot Node 产物 | 构建通过；当前仓库 345 引用：320 有效、2 生成物、23 未确认、0 失效 | `context-build.log`、`context-repo-final.json` |
| Rust 原始依赖、全新 target | 1,695 通过、0 失败、0 忽略；实际执行两个原始补丁 | `rust-clean.log` |
| Rust 默认 target | 清理旧 BoringSSL 构建缓存后 1,695 通过、0 失败、0 忽略 | `rust-normal.log` |
| Clippy 全 targets | 零警告通过 | `clippy.log` |

前端原默认并发下另一次运行有 3 个 UI 测试超时；两个 worker 已写入 Windows 默认配置，未增加超时、启用重试或跳过正式测试。
本机结果不替代远端 CI。所有脚本/测试夹具的数据都不算真实使用或真人认可。

## 第 3 项：工程能力与真实使用评估

用户关注的是 Helmor 的能力，而不是 moyu 的业务质量。工程验证覆盖采集、候选过滤、会话归属、来源隔离、分母和覆盖率计算。
moyu 仅是现有测试样本。用户说明自己不熟悉一线会话，本轮回答没有被记作候选认可，也未写入任何真实现场的 human 事件。

“真实使用者认可率 ≥0.8”仍是产品评估条件；不降低阈值、不借旧答案宣称新验收通过。
[候选与评估边界](l1-review-2026-09-14.md)记录了全量 5 个候选，本轮人答 0/5，留待实际使用者独立复核。
该评估由 [issue #7](https://github.com/Baixu22/VerseSpace/issues/7) 单独跟踪，不冒充代码缺陷，也不影响本轮已经通过的工程能力结论。

## 第 8 项：移除旁路与历史归因

原始 registry 已恢复。官方 Git 2.51、2.53 和经 SHA256 校验的 MinGit 2.55 在临时目录及仓库内的隔离目录中，
均未复现误删兄弟文件、嵌套分支丢失或 remote ref 丢失。Git 2.51 与 MinGit 2.55 均能在两种目录完成 BoringSSL 的两个原始补丁步骤。

这些结果否定了“当前必现”以及“仅凭版本号即可归因”的说法，不能确定旧故障的根因。
没有添加防护排除项，也没有禁用系统防护。历史归因由 [issue #8](https://github.com/Baixu22/VerseSpace/issues/8) 单独跟踪；详见 [Rust 和 Git 环境复验](windows-rust-clean-verification.md)。

## 其他观察与收尾

- `mvp-flow` 中的 `git ENOENT` 来自未建立 worktree 的测试场景，断言验证无法采集回退快照时检查点仍能保存；不是漏装 Git。
- Workbench 与 context-rot 仍在构建时共享源码；两种打包产物的独立工作区冒烟证明运行时不依赖源码目录。暂不为未来拆仓引入新包。
- 任务森林提案 `TFP-issue6-closeout-20260914` 修正 8 个旧节点，新增工程收尾与两项后续跟踪；TF-0057 的产品验收保留待复核，不以“全部 done”掩盖未验证事项。
- GitHub #6 按工程修复关闭，#7/#8 保留明确的验收条件。修复与报告提交至 `feat/premise-evidence-base`；本轮不代表代码已经合入 main 或发布。
