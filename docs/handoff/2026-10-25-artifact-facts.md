# TF-0294：历史来源、当前输入与最新检查

ArtifactReview 现在分别投影历史来源强度、当前声明输入相对最新检查的版本差异、
最近检查 id/结果/范围/authority，以及已有目标适用性。读取不执行检查，不确认通知。
当前来源仍指向原 checkpoint 的历史读取；新重验只推进检查历史和绑定。

`current` 必须来自 verified/applied 生命周期、passed、satisfied 和 command authority，
并且现有执行条件、产物与声明输入绑定仍一致。显式选择的历史来源若只是采样、混合或未知，
保留 unknown；成功范围检查事实单独可见，不把它升级为工具来源。
没有 inputRecords 的旧声明保留较弱的 declared-scope，明确不证明历史工具内容。
内容观察与文件采样不同本身不否定来源内容：真实重验可验证当前声明范围，而原来源仍保留。

复读、通知确认和已看手势不能修复产物。跨文件改动继续形成 stale；失败重验仍 failed；
产物无需修改但新范围检查通过可形成 current。原 applied 记录和 effects 不重放。
有效性事件摘要包括独立事实，事实变化留下新事件，重复 reconcile 不重复追加。

本节点是读取侧事实判定；Runtime 消费前拒绝及 effects 保护由 TF-0295 接续。
现有端点 hash 验证仍不是 ABA/原子快照保证，固定副本验证由 TF-0298 承担。

## 本轮 Windows 实测

Bun 1.3.14，Node v24.22.1，loopback 设置 NO_PROXY；没有真实模型或自然使用测量。

- 三项新事实检查加现有来源选择与产物回归：9 pass / 0 fail，3 文件，18.30 s，exit 0。
  使用真实检查子进程覆盖跨文件变化、复读未修、失败重验、无需修改重验、applied 历史保留、
  采样/未知来源不升级、旧声明较弱兼容和伪造生命周期/报告反例。
- 完整 Workbench：1196 pass / 0 fail，193 文件，34 snapshots，198.42 s，exit 0；
  独立进程墙钟 198.656 s。
- 三包 typecheck、lint、五文件冻结：exit 0；lint 保留一条既有 info。
- 严格上传面在交接后运行；不放宽分类策略。

直接证据 `claim-moat-artifact-origin` 在实现提交之后通过记录器实跑并登记。
原始日志、临时仓库和森林留本机；全局过期读数仍待最终收口刷新。

```bash
bun test packages/workbench/src/artifacts/facts.test.ts packages/workbench/src/artifacts/input-origin.test.ts packages/workbench/src/artifacts/artifacts.test.ts --timeout 60000
bun run test:workbench
bun run typecheck
bun run lint
node packages/workbench/scripts/verify/artifact-use/check-freeze.mjs
bun run check:upload-surface
```
