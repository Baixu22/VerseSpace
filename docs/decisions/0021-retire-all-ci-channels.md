# ADR-0021：退役全部 CI 通道（极狐 / GitLab 与 GitHub Actions 都不再使用）

- 状态：已接受（2026-09-26，用户指示「gitlab 和 github 的 ci 应该关闭，本来就不走他们了」）
- 相关：[ADR-0018](0018-single-ci-channel-jihulab.md)（本 ADR 取代它）、[ADR-0019](0019-phase4-and-release-acceptance-as-external-gates.md)（发行车道保留但不再作为验收）、[ADR-0020](0020-relay-handoff-upload-surface.md)（上传面）

## 背景

ADR-0018 把 CI 收敛成**一条**通道（极狐 / JihuLab 自托管 runner），并删掉了 GitHub Actions。它解决了「三条通道各说一套」的问题，但留下了一个仍然成立的前提：**CI 是一个被依赖的出口**——PR 的绿灯去极狐看，发行链靠 `release` stage 的 `release-build`。

2026-09-26 的实测推翻了这个前提的两个支柱：

1. **CI 不再是唯一能产生有效读数的地方。** 本机（`danger-full-access`，子进程不再被拒）已能跑出三套件全绿（workbench 1004 / ui 67 / context-rot 69，0 fail）、真实浏览器 E2E（14 passed / 0 skipped）、真实 provider E2E（`test:live` 通过）。此前「必须去 CI 才能验证」的理由，主要来自 agent 沙箱拒绝子进程这一本机缺陷，而不是 CI 的独有能力。
2. **这条通道本身在制造噪声。** 同一天的实测：runner 是前台进程，启动它的控制台一关就死，流水线停在 pending 且没有 job 在跑（看起来像 CI 坏了）；只改 `packages/context-rot/**` 的快照 push 不会触发它自己的 job；一次 `context-rot-test` 失败在复跑后变绿（瞬时故障）。用户据此判断：**本来就不走他们了。**

## 决策

**仓库不再配置任何 CI。** 具体：

- 删除 `.gitlab-ci.yml`（verify 与 release 两个 stage 一并消失）。
- 删除 `scripts/win/jihulab-snapshot.sh`——它只为「推孤儿快照触发极狐流水线」而存在，目标已不存在。
- 停掉本机极狐 runner（`verspace-local-jihulab`）。它的启动方式、标签、`resource_group` 约定不再属于本仓库的运行形态。
- 删除 `.github/workflows/` 的动作**不需要再做**：ADR-0018 已经删过，`.github/` 现在只剩 issue / PR 模板。

## 代价与后果

1. **没有自动门禁了。** 绿/红由本机命令给出，且**必须有人跑**。原来的七个 verify job（biome / typecheck / workbench / workbench-ui / context-rot / doctor / upload-surface）现在只有 `bun run …` 这一种入口——命令没变，缺的是「有人一定会跑」。
2. **发行链改走本机。** `release-build`（四平台交叉编译）与手动 `release-publish` 不复存在。发版路径收敛为 ADR-0019 已经写下的那条：`cd packages/workbench && bun run build:all` → `node scripts/publish-workbench-release.mjs --tag workbench-v<version>`。**注意**：`scripts/tag-workbench-release.mjs` 里仍有一段「向 jihulab 推同树快照 tag」——它的唯一用途是让极狐的 release rules 匹配，现在没有规则了。这一段成为**已知的遗留**，处理它属于阶段 D（发行），由维护者在真发版时一并决定（见「复核」）。
3. **PR 上不再有任何状态检查。** 这不是本决策引入的（ADR-0018 已如此），但现在也没有极狐页面可看——**验证记录只剩本机读数与 `docs/handoff/` 里的交接报告**。这让「交接报告写清楚哪些读数是本机实测、哪些没测」变得比之前更重要。
4. **历史文档不重写。** `docs/handoff/*`、`docs/report-*`、`docs/engineering-defect-localization-and-qa-plan-2026-09-24.md` 里关于 JihuLab 的描述是**当时的记录**，按仓库「修正是新条目」的约定保留原样。改的是**活文档**：`AGENTS.md`、`CONTRIBUTING.md`、`packages/workbench/README.md`、`docs/decisions/README.md`。

## 复核（触发重估的条件）

- 出现**必须**由第三方或第二台机器执行的门禁（例如仓库转公开、或需要外部贡献者无法伪造的读数）。
- 出现「本机跑不了、但 CI 能跑」的具体能力缺口（不是「本机不方便」，而是结构性不可达）。
- 真发版时，`scripts/tag-workbench-release.mjs` 的 jihulab 快照 tag 段与 `packages/workbench/scripts/build-single.ts`（ADR-0018 保留的 GitHub 矩阵构建路径）一并清理或明确保留理由。
