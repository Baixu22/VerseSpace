# 验证执行条件与恢复卡真实性修复（2026-09-30）

接续[验证绑定补强](2026-09-30-verification-binding-hardening.md)和[多段读取/前提有效性修复](2026-09-30-read-fragments-and-premise-validity.md)。
基线 HEAD `68ebef5`，工作区包含此前未提交改动。本轮继续修复现有证据链中的具体断点，没有开始完整交接包或跨文件产物依赖图。

## 修复前的独立反例

新增八个契约用例，先在修复前执行：exit 1，0 pass / 8 fail。

- 检查通过后修改 checkpoint 的命令、预期退出码或超时，旧代码绑定仍允许推进；三例均复现。
- 切换到另一个 HEAD 和代码相同的真实 Git worktree，原执行目录的结果被继续沿用。
- 恢复卡仅检查 `verificationResult` 是否存在，将 failed / timeout / skipped / needs_human 全部写为“Verifier 已验证”；四例均复现。

## 本轮实现

- 验证绑定新增可选 `context`，保存规范化的真实 cwd、策略、解析默认值后的命令、预期退出码、有效超时、来源（command / human）。复用现有 verifier 的命令表和超时解析规则，没有另一套默认配置。
- 新检查记录执行时的上下文；批准记录人工来源。自动推进前同时核对代码与当前执行条件，改变任一条件都退回重验。无法解析执行目录时不能签发新绑定。
- `verification-status.ts` 提供只读状态投影。CLI `checkpoint list` 和恢复卡复用它，区分当前通过、人工批准、过期、未知、失败、超时、跳过、待审查。原始命令结果仍保留，查询不改生命周期、不写事件、不重新执行命令。
- JSON 列表在每个 checkpoint 上增加 `currentVerification`；该字段只在返回值中派生，不写回 Blackboard。文本列表直接显示原因。
- 恢复卡不再用历史 `premise_stale` 事件条数冒充当前失效文件数。当前数量取自现有读集投影，历史事件另列；没有可比较观察时明确显示覆盖未知。引用保留 checkpoint、当前保留观察的 footprint 与历史事件依据。
- 旧的无绑定/仅代码绑定记录保持原兼容推进路径；展示为历史结果、当前有效性未知，不能假装旧记录已经拥有新的执行条件证明。

## 验收内容

新增回归共十一例：四个执行条件变化、四种非成功结果展示，以及只读 CLI/恢复卡当前状态、人工批准来源、重读后当前前提归零但旧验证仍过期。
其中执行目录用真实 Git worktree；CLI 用真实子进程回读 JSON；校验查询前后事件数量与原始 passed 记录不变。
原有正常 applied → done、退回重验、修复后重新绑定和旧记录兼容用例继续保留。

已执行的定向读数：

- 首次修复后四文件回归：exit 0，27 pass / 0 fail，98 个断言。
- 补充只读展示和当前前提回归后，本轮十一例：exit 0，11 pass / 0 fail，33 个断言。

本轮完整读数（Windows / Bun 1.3.14，当前合并工作区）：

| 命令 | 结果 |
| --- | --- |
| `bun run test:workbench` | exit 0，1068 pass / 0 fail，167 files，34 snapshots，4678 个断言，141.38 秒 |
| `bun run test:workbench-ui` | exit 0，18 files / 68 tests passed，9.03 秒 |
| `bun run test:context-rot` | exit 0，69 pass / 0 fail，171 个断言 |
| `pwsh -NoProfile -File scripts/win/e2e-browser.ps1 -ApiPort 7846 -UiPort 5328 -KeepWorkspace` | exit 0，真实 Chromium 14/14 passed，29.7 秒；未调用模型 |
| `bun run typecheck` | exit 0，三个包 |
| `bun run lint` | exit 0，674 files |
| `git diff --check` | exit 0 |
| `bun packages/workbench/src/index.ts doctor` | exit 0，118 条断言、0 失效，blackboard 正常 |
| `bun run check:upload-surface` | exit 0，857 个上传面文件、违规 0；532 条相对链接、断链 0；两条既有 node_modules 链接警告仍在 |
| `bun run check:claims` | exit 1，13 stale / 2 valid / 1 observation；未重录注册读数 |

原始日志在本机 `.agent-contexts/verification-context-20260930/`，不上传。

## 边界

- 本次修的是既有检查的执行身份与展示，不宣称完整验证范围推导、用例集合证明、工具链/环境指纹或外部服务稳定性。
- 前后比较不是原子快照，仍不能排除先改后还原的 ABA。
- 只读投影可以报告 applied 记录已过期，但不会撤销已执行的账本效果或自动重做已完成目标。
- 人工批准是人工决定，不是自动检查复跑；重读文件只能刷新输入观察，不证明旧产物或旧测试重新成立。
- 没有修改任务森林、重录 claims、提交、推送、发布或调用真实模型；没有重开 ADR-0024 退役范围。
