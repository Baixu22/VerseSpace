# ADR-0018：CI 单一通道 = JihuLab（极狐）；退役 GitHub Actions 与 gitlab.com 车道

- 状态：已接受（2026-09-22，用户指示「gitlab 和 github 的 CI 都可以关闭了，均使用这个 jihulab」）
- 森林节点：TF-0232 落地过程中产生
- 取代：[ADR-0015](0015-legacy-retirement-execution.md) 中「保留 `.github/workflows/release-workbench.yml`」一句，以及 `.github/workflows/ci.yml` 作为 CI 通道的地位
- 相关：[ADR-0014](0014-legacy-retirement-gate.md) / [ADR-0015](0015-legacy-retirement-execution.md)（存量退役）、[ADR-0017](0017-second-observable-provider-integration.md)（第二个可观测 provider）

## 背景

先后存在过三条 CI 通道：

1. **GitHub Actions**（`.github/workflows/ci.yml` + `release-workbench.yml`）——2026-09-21 起私有仓库的 Actions 计费额度耗尽，job 永远拿不到 runner（每次 4–6 秒失败，`gh run list` 可复核）。ADR-0015 当时的选择是「保留 `release-workbench.yml`，等额度恢复」。
2. **gitlab.com 自托管 runner**（id 56555227）——为绕开 GitHub 计费而建，2026-09-22 被拆掉（配置留档 `D:\software\gitlab-runner\config.toml.bak-pre-gitlab-teardown`）。
3. **JihuLab（jihulab.com，极狐）自托管 runner**（id 47590，`verspace-local-jihulab`）——现役，已实测跑通完整 verify 套件（biome / typecheck / workbench / workbench-ui / context-rot）。

留三条通道的成本不是零：`.github/workflows/*` 会继续在 PR 上留下永远失败的红叉，把「计费」误读成「代码坏了」；`release-workbench.yml` 描述的发行形态与真正在跑的 JihuLab 发行车道是两套；文档与脚本各说一套——本轮就修过一次 `git push gitlab` 指向一个根本不存在的 remote。

## 决策

**CI 只有一条通道：JihuLab（jihulab.com）。** GitHub 继续承载仓库、PR 与 Release 对象，但不再承载 CI。

- **删除** `.github/workflows/ci.yml`、`.github/workflows/release-workbench.yml`，以及只被它们使用的 `.github/actions/setup-js/`。GitHub 上的 PR 不再有状态检查。
- **不再使用** gitlab.com 通道（该 remote 已不存在）。
- **保留 `.gitlab-ci.yml`**（JihuLab 本身就是 GitLab 实例，文件名不变）：verify 与 release 两个 stage 都在这里。
- 发行链：`scripts/tag-workbench-release.mjs` 向 origin 推真实 tag、向 jihulab 推**同树快照 tag**；`release-build` 交叉编译四平台二进制，`release-publish`（手动）跑 `scripts/publish-workbench-release.mjs` 挂到 GitHub Release。
- 推 CI 用 `scripts/win/jihulab-snapshot.sh`（孤儿快照）：本地 `.git` 背着约 2 GB 的 `events.jsonl` 历史，直推会把它整份上传；`main` 与 `feat/*` 在 JihuLab 受保护，快照推到去掉前缀的扁平 ref。

## 代价与已知限制

- **GitHub 侧不再有任何自动检查**：PR 的绿灯来自 JihuLab，需要人工去 JihuLab 页面或 runner 日志确认。没有把 JihuLab 状态回写到 GitHub PR（那需要 GitHub App 或 PAT，本轮不做）。
- **CI 依赖本机开机且 runner 在跑**：runner 是前台进程而非 Windows 服务，控制台关闭即死（2026-09-22 实测：22:09 死，之后所有推送空等，GitLab 侧 pipeline 停在 pending）。装成服务是持久解，需要管理员权限。
- **平台覆盖仍然只有 Windows**：四个二进制都由这台 Windows 主机交叉编译，只有 windows-x64 跑过测试，macOS / Linux 未在真实宿主上冒烟。这不是本决策引入的，但本决策让 JihuLab 成为唯一出口后，它更容易被误读成「CI 全绿 = 全平台验证过」，因此在这里再写一次。
- **重活必须串行**：runner `concurrent = 4` 而主机 16 GB，`typecheck` / `workbench-test` / `workbench-ui-test` 共用 `resource_group: heavy`；否则重活互撞会让测试跑满时长后 exit 1（2026-09-22 实测）。

## 复核

- 触发重估：GitHub Actions 恢复可用**且**出现需要 GitHub 原生状态检查的场景（例如仓库转公开，或需要 PR 上直接看到检查结果）；或 JihuLab 通道不可用且在合理时间内无法恢复。
- 恢复 GitHub 车道时：从本 ADR 之前的提交取回 `.github/workflows/*`、`.github/actions/setup-js/` 与 `packages/workbench/scripts/build-single.ts` 的调用方（该脚本本身保留在树里，见下），并新增一条 ADR 记录取代关系。

## 未删除但已无调用者的东西（明确的保留决定）

- `packages/workbench/scripts/build-single.ts`：GitHub 矩阵「一台主机构建一个目标」的路径，JihuLab 的 release 阶段改用单机 `build:all`，因此它当前没有调用者。**决定保留**（而不是像 TF-0236 的 stash 原语那样删掉），因为它是恢复 GitHub 车道时要一起取回的东西，且已在文件头注释里写明「当前无人调用」以免被误读成在用的构建路径。
