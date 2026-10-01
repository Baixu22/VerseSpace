# Issue 接力收口（2026-10-01）

接力候选为 PR #58 的 `e2b2ad9`，14 个开放项为 #31、#45–#57。上一轮实现与读数见[实现记录](2026-10-01-all-issues-implementation.md)。本轮先在干净验收副本复跑旧候选：workbench 1093 pass / 0 fail，176 files，34 snapshots，4828 assertions，160.47 秒。

## 补修 #53

发现“修改”指标把每次写入与最初产物版本比较：先从 A 改为 B，后续窗口再写 B 仍被算作本次修改。新增反例先失败（3 pass / 1 fail），修复后按最近可观测版本比较；同内容重复写不计修改，缺可比较版本保留 unknown，真实 B → C 仍计 observed。旧 repaired 算法与历史记录不改。

## #31 原生审批的真实对照

Windows x64、Bun 1.3.14、Codex CLI 0.159.0，用户指定本地 GLM 5.3 flash Responses 服务。独立 CODEX_HOME：on-request、read-only、Windows elevated sandbox、high reasoning，model_catalog_json 显式声明 apply_patch_tool_type=freeform。日常 profile 未修改；密钥只经环境传入，不上传。

OpenAI 配置参考允许启动时加载 [model_catalog_json](https://developers.openai.com/codex/config-reference)。本次实际配置由 CLI debug models 确认含原生工具声明；它是实验前提，不证明任意模型都会使用该工具。

首次原生对照真实结果（每个场景的 instrument exit 均为 0，只表示观测完成）：

| 场景 | 本写者失效 | 写入 | 原生写足迹 | seal 事件 | 冻结对照 | 写回合复读 |
| --- | --- | --- | --- | --- | --- | --- |
| own-fresh | 0 | 落盘 | 1 | 1 pass | pass | 0 |
| own-stale | 1 | 未落盘 | 0 | 1 block / stale_premise | block | 0 |

这一次拒写可归因于 Workbench 的封印，而不是仅凭 CLI 只读沙箱推断。补留 0.159 原生 item → approval → completed 脱敏夹具；原 0.158 add/update 和 declined/failed 回归继续保留。真实流新增的 reasoning summary、命令输出 delta、审批完成及汇总 diff 均按已有最终 item 的权威输出明确处置，不再未建模报警。

为采集原始协议又跑了一对：fresh 同样成功，stale 模型报告补丁上下文不匹配，协议中没有原生 item/审批、seal=0。这次不是封印通过；保留为不可证明的样本，不覆盖上面的成功对照，也不声称模型稳定服从工具要求。原始日志留在本机 `.agent-contexts/issue31-model-tools/`。

新增成对仪器 `bun packages/workbench/scripts/verify/codex-native-pair.ts`，只有 fresh/stale 均满足可归因审批、正确写入/足迹、无复读且不降级才 exit 0；未到达封印的拒写不能通过。旧 shell 写入缺口改为具名历史观测，原 reading 不改写；新的原生命题独立登记。

仍不保证无审批、未归因 shell、缺读取足迹、未知路径、封印故障时的写保护。Codex 仍是实验通道；本轮不扩大为全仓守卫、不引入任意 Shell 解析器。

## 交付与验收

本轮固定候选上的最终注册读数、构建和主线落地状态将在完成后追加。用户原有 README、资产、上传政策和调研文档保持在根工作区；个人任务森林不修改。没有发布新版本或 Release，不运行已退役的非 Windows 执行或真人研究。

为避免 stale 的声明行改名同时造成补丁上下文失配，后续仪器保留不变的追加锚点，并要求同一条精确原生补丁。失效仍来自声明行变化、同一写者全文件读足迹；不复读、不改封印条件。

## 最终固定候选读数

最终源码候选 `951ec039bbe7de39e7e5b173a9653185a42824fe`。旧验收目录被外部移除后，新建本聊天的 `issue-relay-acceptance` 干净检出，`bun install --frozen-lockfile` 成功；所有下表命令均经 record-reading --run 重跑登记，不恢复丢失目录的旧读数冒充新运行。

| 门禁 | 真实结果 |
| --- | --- |
| workbench | 1096 pass / 0 fail；177 files、34 snapshots、4857 assertions；161.83 秒 |
| UI | 18 files / 68 passed；9.18 秒 |
| context-rot | 69 pass / 0 fail；171 assertions |
| Windows Chromium | 14 passed / 0 failed / 0 skipped；30.9 秒 |
| 原生 Codex 成对仪器 | 2/2，exit 0；fresh pass + 1 footprint，stale block + 0 footprint，两者无复读 |
| typecheck / lint | exit 0；lint 实际处理 689 文件 |
| doctor | exit 0；118 条架构断言、0 失效 |
| strict upload-surface | exit 0；0 违规、382 条相对链接、0 断链 |
| upload-surface tests / claims evaluator | 30/30、15/15 |
| premise benchmark | 14/14 合成契约；同尺寸大文件盲区仍明确保留 |
| build + test:build | exit 0；native 和 JS 的 init/doctor/stats/headless UI/bundled UI 均通过 |

过程中 `dbd93d5` 的全量出现 1095 pass / 1 fail：旧测试仍要求新增已处置的遥测事件为 undecided。更新历史预期后定向 7/7，再完整运行得到上表结果；失败轮不登记为通过。

本次本地构建 SHA256：Windows native `0109404c7339a84882fa0d0cb55e271480f5a2d35d9f4e9d82729539d095881f`，JS `f1653054b9aac405b49dc0bdeecfbdec4e830d330c0e001eee86b4e741f27581`。未发布 Release，未执行非 Windows 二进制。

合并前 check:claims 为 exit 1：14 valid、2 historical observations、1 stale（forest-landing）。这不是产品套件失败；主线落地必须在实际合并后重测。根工作区保留用户原有 9 项 README/素材/上传政策/调研改动，不能称根工作区 clean。所有受测读取对象、仪器哈希与原始输出摘要均在 evidence/readings 中；raw 保留本机。
