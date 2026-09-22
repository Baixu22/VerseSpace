# ADR-0019：阶段 4 与发行验收转为常设外部门（不作为本轮交付）

- 状态：已接受（2026-09-23，用户指示「强依赖 codex 或者 Claude Code 这样的阻塞节点都可以 pass」「发行也 pass，有一个编译版本做好 github 的社区工作即可，不要做多余的内容」）
- 森林节点：TF-0232（据此收口）；影响 TF-0237、TF-0251
- 相关：[ADR-0017](0017-second-observable-provider-integration.md)（第二个可观测 provider = codex 车道）、[ADR-0018](0018-single-ci-channel-jihulab.md)（CI 单一通道）

## 背景

TF-0232 的验收原文允许两条路：**阶段 1–4 全部收口，或以新 ADR 明确记录不做的部分**。阶段 1/2/3（TF-0233 / TF-0239 / TF-0245）已收口，剩下两项都卡在「本轮拿不到的外部条件」上：

1. **阶段 4（TF-0251）只认自然人类使用产生的读数。** 判据是 `seal.decisions ≥ 1`、恢复卡消费、人类地标认可。2026-09-22 本轮实测：`seal.decisions=0`（`lastDecisionAt=null`）、`lifecycle.resumeNotesConsumed=0`、`landmarkReviews.current.reviewed=0`；`threads.footprintCoverage=0.73` 是四项里唯一已达标的读数。更关键的是根因：**seal hook 从未安装进 `.claude/settings.json`**，所以任何写操作都不可能产生 `seal.decided`——「读数为 0」有一部分根本不是「人类没用」。该窗口还依赖一条外部 CLI 车道（codex 未安装，claude 车道可用）与真人操作。按来源纪律，脚本或代理代跑会污染 fit 账本，等于把判据本身作废。

2. **发行验收（TF-0237）要求两件本机拿不到的东西。** 其一是「真实 `workbench-v*` tag 走完 `release-build` → `release-publish`」——`release-build` 已在 JihuLab 实测跑通（流水线 5524396，job 29019253，82.2s），但 `release-publish` 需要一次真发版决策；其二是「至少一个非 Windows 平台的冒烟」，在本机**结构性不可达**：WSL2 起不来（`bcdedit` 的 `hypervisorlaunchtype Off`，需管理员改 + 重启），无 docker / podman / qemu，JihuLab 只有本机 Windows shell runner，GitHub Actions 计费额度耗尽。已记偏差 `TFD-07ee49b62f`（`acceptance_unreachable_on_host`）。

把这两项继续挂在森林里当 open 项，代价是把「等外部条件」误读成「还有活没干」，并让整棵森林永远无法收敛。

## 决策

**两项都转 deprecated，按 TF-0232 验收的第二条路（新 ADR 记录不做的部分）收口。**

1. **阶段 4（TF-0251）不是本轮交付。** 它是**常设人工门**：判据不因工程动作而移动，何时跑窗口由使用者决定。跑完之前 fit 账本的四项护城河判决保持「证据不足」，**不得**由工程完成度推出任何方向性结论。
2. **发行验收（TF-0237）不再作为结案条件。** 不再要求「真实 tag 走完 release-build → release-publish」，也不再要求非 Windows 平台冒烟。发行以**「一个可下载的编译版本 + GitHub Release + 社区面」**为准。已实测的部分（release-build 在 JihuLab 上跑通、四平台交叉编译产物形态正确）保留为**能力证据**，不升级为验收。
3. **发行车道本身保留。** `.gitlab-ci.yml` 的 `release` stage、`scripts/tag-workbench-release.mjs`、`scripts/publish-workbench-release.mjs` 都不删——它们是恢复正式发版时要用的东西，只是当前无人按验收跑它们。

## 代价与已知限制

- **fit 账本继续停在「证据不足」。** 这是**有意保留的空白**，不是遗漏：护城河 A/B/C/D 的判决仍然只在自然证据下移动（与 `TFD-f44720fb5f`、`TFD-3e6852f0aa` 的来源纪律一致）。
- **非 Windows 平台从未被验证。** 四个二进制都由这台 Windows 主机交叉编译，只有 windows-x64 跑过测试。**不得**因为本 ADR 把「未验证」读成「已验证」；发行说明里那句平台覆盖声明必须继续保留。
- **发行车道无人按验收跑。** 它可能随仓库演进而腐坏而无人察觉（例如 tag 脚本依赖的 remote 配置、`release-publish` 依赖的 `gh` 登录）。恢复发版时先按 `packages/workbench/README.md` 的「发行」一节重跑一次 dry-run。

## 复核

- **触发重估**：出现真实人类使用窗口（阶段 4 被真正执行）；或需要一次正式发版；或仓库转公开（届时 GitHub Actions 额度与 PR 状态检查的价值需要重新评估，见 ADR-0018 的复核条件）。
- **补非 Windows 冒烟的路径**：先修宿主（`bcdedit /set hypervisorlaunchtype auto` + 重启，再用 WSL 跑 `workbench-linux-x64`），或在一台 Linux 主机上跑一次，把读数补进当时的节点。不要在没有执行读数的情况下声称该步已完成。
