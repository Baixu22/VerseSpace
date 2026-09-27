# `docs/handoff/` — 接力交接记录

本目录是**每一轮开发交接记录的唯一入库位**。口径见 [ADR-0020](../decisions/0020-relay-handoff-upload-surface.md)。

## 为什么是目录，而不是逐文件白名单

`docs/*` 整体忽略，只有少数被显式 `!` 回来。逐文件白名单会漂移，而且漂移是静默的——2026-09-25 上一轮的交接报告就是这样掉出去的：分支上有 6 个 commit，报告本身却被 `.gitignore` 排除、从未提交。**唯一能让下一个操作者换台机器接着干的那份文件，恰恰没上传。**

`.gitignore` 现在白名单整个 `docs/handoff/`。写进这里就自动上传，不需要记得改 `.gitignore`。

## 一份交接记录要回答什么

它必须让**没参与本轮的人**在**另一台机器**上复核本轮主张。最少包含：

1. **结论与标签** —— 工程门 / 产品证据分开写，不用工程测试冒充真人数据或真实浏览器。
2. **改了什么** —— 按节点列 `file:line`，不写「优化了若干」。
3. **证据读数** —— 每条命令的 exit code、pass/fail/skip、耗时；**并标明哪些读数在本机无效、为什么**。
4. **刻意没做什么** —— 以及理由。这一节通常比「做了什么」更值钱。
5. **下一步与遗留风险** —— 让下一位接力者能直接开工。
6. **复核命令** —— 复制粘贴即可跑，不依赖本机独有路径。

## 不要写进来的东西

原始日志、探针 dump、E2E 现场、agent transcript、会话草稿、任务森林数据、构建产物。
这些留在本机（`.agent-contexts/` 等），**精选读数**写进本目录的记录与 `docs/` 报告。

## 上传前的自查

```bash
bun run check:upload-surface        # exit 0 才干净
bun run test:upload-surface
```

门禁会对**双向**报错：该传没传（`useful-not-uploaded`）、不该传却传了（`useless-uploaded`）、
没人做过定性（`unclassified`）、单文件超限（`oversize-uploaded`），并逐条解析上传面 `.md` 的
**相对链接**（`broken-relative-link`：目标按引用文件所在目录解析后既不是文件也不是目录即违规，
2026-09-26 起可测，见 [断链检查记录](2026-09-26-upload-surface-links.md)）。另有
`referenced-but-local` 是**待裁决信号**而非违规，只有加 `--strict-references` 才升级为违规。
若本机禁止 node 创建子进程，门禁报 exit 2「无法测量」——按脚本头部说明用 `--lists <dir>` 喂入清单，
**不要**把 exit 2 读成通过。
