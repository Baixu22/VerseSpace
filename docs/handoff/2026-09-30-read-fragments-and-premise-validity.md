# 多段读取与前提有效性修复（2026-09-30）

接续[短板调查](2026-09-30-product-gaps-and-moat.md)与[验证绑定修复](2026-09-30-verification-binding-hardening.md)。
基线 HEAD `68ebef5`，工作区包含此前未提交的修复和文档。本轮落实多段读取保留、通知送达与当前输入有效性分离；不实施完整交接包或跨文件产物依赖图。

## 行为变化

| 场景 | 现在的行为 |
| --- | --- |
| 先读 1–2 行，再读 9–10 行，随后第 1 行变化 | 保留两个范围，检测第一段失效；两段之间未读的变化不因合并范围而误报 |
| 局部重读文件的新版本 | 只刷新对应观察，不把其他旧范围一起标为新版本 |
| 通知已经送达，但写者仍持有旧输入 | 当前查询与 seal 仍能发现失效；不依赖通知再次入队 |
| 已重读当前版本，但旧通知尚未确认 | seal 不再因那条旧通知误阻断 |
| 文件已变，周期检测尚未执行 | 生产 seal 入口直接核对当前观察与磁盘，无需先生成 pending 通知 |
| 离开后恢复、分叉继承 | 消费全部保留的观察；恢复卡按受影响片段的实际 footprint 引用，不错引最后一次无关读取 |
| 同一路径的快照被更新、丢失或内容不符 | 快照使用唯一名称；比较前核对观察版本，不能借用别的版本的快照得出“未变化” |

## 最小实现与语义

- `session-view.ts` 从原有追加式足迹重建 `readFragments`。`reads` 保留“最后观察”的兼容视图，有效性、恢复和继承调用方使用 `readFragments`；没有重写旧日志。
- 每个片段保留自身版本、范围、seq、可用快照。相同坐标的明确重读替换该坐标的旧观察；同版本的包含范围可以淘汰冗余片段；不同版本的部分重叠不拼成“最新全文”。完整且有可比版本的重读可以刷新整个文件。
- 坐标刷新属于输入观察，不是证明某个语义依赖或旧计划被修好；跨版本移动的代码没有符号级映射。需要消除保守残留时可完整重读。无法测量的读取不能覆盖已知版本，size-only 读取不能把旧的精确哈希观察洗成弱保证。
- 自身已测量写入仍按既有契约更新该文件的观察基线，不据此证明派生产物正确。
- `premise-check.ts` 共用于主动检测和只读当前查询。每个路径只报告一个失效实例，通知/覆盖分母保持文件级；多片段不会凭空增加“文件数”。检测、去重和投递的原始事件仍追加保存。
- `decideSeal` 的生产入口按写者动态取得当前失效输入。显式 `claims` 仅用于受控测试或冻结证据调用；Claude hook 与 Codex 生产入口不再提供 pending claims。
- 快照文件名增加唯一标识，避免同毫秒同路径覆盖。比较须核对其 hash 与观察版本；淘汰/缺失/不匹配时保守降级，不替换成最新快照。保留原有快照容量，不新增数据库或缓存。

## 查询方式

```text
workbench premises current --writer <id> --json
workbench premises pending --json
workbench sessions show --writer <id> --json
```

`current` 查询当前失效输入；`pending` 只回答哪些历史通知未送达，两者数量可以不同。
`sessions show` 的 JSON 增加 `readFragments`，保留旧 `reads` 字段，文本模式列出范围。
MCP 的 `premises` 工具增加可选 `view: "current"`；缺省仍为 `pending`，保持现有调用兼容，工具总数仍为五。
当前查询不写事件、不确认通知；空结果仅表示在已记录、可观测读取中未检测到失效，不表示全覆盖。

## 本轮实测

以下为本轮 Windows / Bun 1.3.14 真实读数，覆盖当前合并工作区（包括此前未提交改动）：

| 仪器 | 最终结果 |
| --- | --- |
| `bun run test:workbench` | exit 0，1057 pass / 0 fail，166 files，34 snapshots，4644 个断言，143.08 秒 |
| `bun run test:workbench-ui` | exit 0，18 files / 68 tests passed，8.96 秒 |
| `bun run test:context-rot` | exit 0，69 pass / 0 fail，171 个断言 |
| `pwsh -NoProfile -File scripts/win/e2e-browser.ps1 -ApiPort 7844 -UiPort 5326 -KeepWorkspace` | exit 0，真实 Chromium 14/14 passed，28.2 秒；未调用模型 |
| `bun run typecheck` | exit 0，三个包 |
| `bun run lint` / `git diff --check` | 均 exit 0；Biome 检查 671 files |
| `bun packages/workbench/src/index.ts doctor` | exit 0，118 条断言、0 失效，blackboard 正常 |
| `bun packages/workbench/scripts/benchmark-premises.ts --json` | exit 0，14/14 合成契约场景 |
| `bun run check:upload-surface` | exit 0，853 个上传面文件、违规 0；529 条相对链接、断链 0；仍有两条既有 node_modules 链接警告 |
| `bun run check:claims` | exit 1，13 stale / 2 valid / 1 observation；未重录注册读数 |

定向与过程读数：

- 九文件相关回归：exit 0，67 pass / 0 fail，227 个断言。
- 补充分叉与 size-only 观察用例后，读取片段及大文件回归：exit 0，6 pass / 0 fail，37 个断言。
- 前提检测基准：exit 0，14/14；这是合成契约读数。
- 完整后端首轮：exit 1，1056 pass / 1 fail。旧 Codex 基线夹具以 `version=null` 构造“新鲜”对照，现改为真实文件 hash；实验基线同时拒绝不可比较的目标读取。该夹具与生产入口回归四个用例复跑 exit 0。

生产调用链证据包括真实 CLI 子进程（seal exit 2/JSON、current 查询）及受控 Codex app-server 子进程（他人失效不阻断自己、已送达的自身失效仍 cancel、当前重读后 accept）。这些不是实际模型实验。
原始日志在本机 `.agent-contexts/premise-validity-20260930/`，不上传。

## 未扩大的保证

- 输入刷新不等于产物验证。没有新增产物待重验对象、跨文件因果关系或语义级修复判据。
- seal 的通道、只读路径、连续命中降级及错误处理边界不变；它不是全局写锁。Codex 仍是实验通道，缺失审批/足迹等限制保留。
- 观察与磁盘读取不是原子操作；大文件同尺寸改写、无法识别的工具和目录检索仍按原边界披露。恢复检查在部分片段不可比较时，不把整条路径计为完全可比。
- 保留的观察来自日志重放，无额外静默容量淘汰；跨版本部分重叠可能保守保留冗余。长周期日志容量与性能没有在本轮验收。
- 未重录 claims、未改任务森林、未提交/推送/发布；未运行真实模型、构建形态或退役的外部验证项目。
