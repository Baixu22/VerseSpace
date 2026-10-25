# TF-0289：观察内容、文件版本与采样来源

本节点只交付来源类型、保守降级和读取事件关联。生产 Claude/Codex 捕获仍使用旧逻辑，
返回内容绑定由 TF-0290 接续；这里的通过不代表采样竞争已在生产通道修复。

`FootprintUsed.observation` 为可选、严格 schema，版本为 1。分别记录工具返回原文摘要
`returnedHash`、规范化内容摘要 `contentHash`、完整文件采样版本、选择范围和稳定性。
`tool-observed`、`fs-sample`、`declared`、`unknown` 互不升级；旧日志缺字段、size-only、
无效摘要、目录 selector、截断、范围错配和不稳定采样保持来源或版本关联未知。
返回内容与稳定采样不同，明确投影 `different`，不能用较新的文件 hash 替换返回凭据。
既有 `claimStrength`、`claimVersion` 和前提检查行为保持兼容。

`readFragments` 保留路径、行范围、实际执行者、足迹序号及镜像事件 id/序号。
新增关联字段不改变旧日志的观察强度，也不把重读当作产物修复。

## 实测

Windows，Bun 1.3.14，Node v24.22.1，loopback 设置 `NO_PROXY`。

- 直接来源检查及 sessions/read-fragments 回归：17 pass / 0 fail，3 文件，610 ms，exit 0。
  其中 7 项新增检查复用冻结的 `capture-race` 内容，覆盖不同 hash 对象不可互换、旧日志、
  弱采样/声明、无效范围、版本关联及读取事件身份。
- 完整 Workbench：1177 pass / 0 fail，187 文件，34 snapshots，178.88 s，exit 0。
  独立进程状态记录的墙钟为 179.038 s；上一轮会话丢失且无终态汇总，未作为通过读数。
- 三包 typecheck、lint、五文件冻结校验：exit 0。lint 保留一条既有 info。
- 上传面严格门禁：exit 0；未放宽分类策略。日志、进程状态及森林留本机。

直接读数：`claim-moat-input-origin`，由记录器在实现提交后实际执行聚焦检查再登记。
全局旧读数可能因源码变化过期，不能把本节点结果当作全局最终收口。

## 重放

```bash
bun test packages/workbench/src/blackboard/input-origin.test.ts packages/workbench/src/blackboard/sessions.test.ts packages/workbench/src/runtime/read-fragments.test.ts --timeout 60000
bun run test:workbench
bun run typecheck
bun run lint
node packages/workbench/scripts/verify/artifact-use/check-freeze.mjs
bun run check:upload-surface
```

`utf8-lines-v1` 是本节点预留并校验的规范化标签；实际换行与工具包装解析随 TF-0290 实现，
没有在此节点对未知工具输出推断内容。没有新增依赖、数据库、Shell 解析器或 UI。
