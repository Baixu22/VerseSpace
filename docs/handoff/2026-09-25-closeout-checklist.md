# 落库收口清单：把 `qa-stage-ab-remediation` 落进 main（2026-09-25）

> **这份清单不是"本轮已完成"的记录，而是"下一次必须做的事"。**
> 它存在的理由：森林里的 `done` 与 git 的权威分支是**两件事**。
> `TFD-0dab4149f2` 记录过这个盲区——`check-landing` 只把 done 节点的 `updated_at` 与
> HEAD 提交时间比对，测不出「代码只在未合并分支上」；2026-09-23 的阶段 3 就是这么
> 读成已落库的。当前分支正是同一形状：**14 个 commit 全在本地**。

---

## 1. 现状（本机实测，2026-09-25）

| 读数 | 值 |
| --- | --- |
| 分支 | `qa-stage-ab-remediation`（**无 origin 对应 ref，纯本地**） |
| `main` / `origin/main` | `45f0a9b`（同步） |
| `main..HEAD` | **14 commit / 51 文件**（截至本清单撰写时；**本清单自身随后成为第 15 个 commit / 第 52 个文件**——写死这个数会立刻过期，所以以 `git log --oneline main..HEAD` 的现场读数为准） |
| 工作树 | clean |
| `git branch --no-merged main` | `chore/phase1-closeout-20260921`（仅 `.agent-workbench/` 森林记账，非代码缺口）、本分支（**有代码缺口**） |
| `node scripts/check-forest-landing.mjs` | **exit 2 无法测量**（`spawnSync git EPERM`——agent 沙箱拒绝创建子进程） |
| `python <task-forest>/task_forest.py check-landing` | **exit 1 + `WinError 5`**（子进程管道被拒）。⚠️ **这里的 exit 1 是"跑不起来"，不是"检测到漂移"**——它的 exit 1 在正常语义下表示 drift，别把这个读数读成后者 |
| `bun run check:upload-surface --lists …` | exit 0（上传面 768 / 违规 0 / 待裁决 6；含本清单自身） |
| 森林 `validate` | exit 0，269 节点 |

**所以本机拿不到"是否已落库"的有效读数。** 第 3 节的步骤必须在**无沙箱 shell** 里做。

## 2. 合并后从「分支上完成」变成「已落库」的节点

这 6 个 `done` 节点的代码全部只在本分支上：

| 节点 | 标题 | 分支上的 commit |
| --- | --- | --- |
| TF-0256 | 写 API 的非法 JSON 统一拒收 | `13adf58`、`1424f03`、`843793d` |
| TF-0257 | UI 资源损坏不再以 HTTP 200 冒充健康 | `3276440` |
| TF-0258 | 路由 contract / 浏览器 E2E / 真实 provider E2E 分三类报告 | `85b47c7` |
| TF-0260 | 后台 reconcile 的 config 读取失败给出独立身份 | `de1bbf9` |
| TF-0261 | catch 后继续的仓库级错误身份审计表 | `0bff98f`、`1424f03`、`98f6781`、`843793d`、`67506c7` |
| TF-0268 | 接力交接的上传面定性（ADR-0020） | `d6ade98` |

另有 **2 个 `in_progress` 节点带部分代码**：TF-0255（`1fde1f7`）、TF-0269（`67506c7`）——
它们**不会**因为合并而变成 done，验收仍未达成。

> TF-0220 被 `d6ade98` 的消息提到，但它在 2026-09-19 的 `9888021` 就落库了，
> **不在缺口内**——这里点名是因为"被 commit 消息提到"与"代码只在本分支"是两件事。

## 3. 无沙箱 shell 里的收口步骤

**Step 0 · 前置**：确认不在 agent 沙箱里（`git status` 与 `bun test` 都能正常 spawn 子进程）。

**Step 1 · 复跑门禁**（这是本轮**唯一一次**能拿到三套件有效读数的机会）

```bash
bun run typecheck          # 期望 exit 0
bun run lint               # 期望 exit 0
bun run test:workbench     # 本机沙箱外应可全绿；记录 pass/fail/skip
bun run test:workbench-ui
bun run test:context-rot
bun packages/workbench/src/index.ts doctor   # CI 的 doctor job 用的就是这一条
bun run build:ui                             # CI 的 workbench-ui-test job 里也有它
cd packages/workbench && bun run build       # 单文件二进制 + npm 包 + UI 资产
```

命令名与 `.gitlab-ci.yml` 的 verify 阶段一致（`biome` / `typecheck` / `workbench` /
`workbench-ui` / `context-rot` / `doctor` / `upload-surface` 七个 job）——
**在本地跑的就是 CI 会跑的那些**，别自创一套。

任何 fail 都要**先归因再下结论**：真实回归 / spawn 拒绝 / 注入代理 / Windows 删除慢。
把读数与归因写进下一步的 PR 正文（§4）。

**Step 2 · 两个门禁 + 森林**

```bash
bun run check:upload-surface                          # 期望 exit 0
python C:/Users/27933/.workbuddy/skills/task-forest/scripts/task_forest.py \
  validate --workspace D:/helmor-main                 # 期望 exit 0
node scripts/check-forest-landing.mjs                 # 期望 exit 1（HEAD 领先 main 14 个 commit）
```

**exit 1 在这一步是预期读数**——它正是"还没落库"的测量结果。落库后再跑它才算验收。

**Step 3 · 推到 origin 并开 PR**（真实历史）

```bash
git push -u origin qa-stage-ab-remediation
```

PR 正文用 §4 的草稿。**不要**把 JihuLab 快照当作 PR 的来源。

**Step 4 · 推 JihuLab 孤儿快照触发 CI**

```bash
"C:\Program Files\Git\bin\bash.exe" scripts/win/jihulab-snapshot.sh
```

- 脚本提交的是当前树作为 **parent-less** commit，ref 名会剥掉 `feat/` 前缀
  （`main` 与 `feat/*` 在 JihuLab 受保护，pre-receive 会拒绝强推）。
- 流水线状态：<https://jihulab.com/Baixu22/VerseSpace/-/pipelines>，或 runner 日志
  `D:\software\gitlab-runner\runner.err.log`（按 `job_name` / `pipeline_id` 找）。
- **runner 是前台进程**：没有 `Get-Process gitlab-runner` 就是 runner 死了，
  不是 CI 失败——先 `D:\software\gitlab-runner\start-runner.bat`。
- `resource_group: heavy` 让三个重活串行；`concurrent = 4` 下不要同时跑本地全量 UI 套件。

**Step 5 · CI 绿 → 合并到 main**

合并方式按仓库习惯（PR merge）。合并后 `main` 才第一次包含这 51 个文件。

**Step 6 · 落库后复跑（这才是验收）**

```bash
node scripts/check-forest-landing.mjs                 # 期望 exit 0
bun run check:upload-surface                          # 期望 exit 0
git log --oneline -n 15                               # 期望看到这 14 个 commit
```

**Step 7 · 森林收口**

- 把 Step 6 的读数作为 evidence 追加到 **TF-0252**（本轮根目标），并在其中写明
  §2 的 6 个节点此时才是"已落库"。
- `TFD-460861548d`（landing_branch_only_unverified）与 `TFD-0dab4149f2`
  （landing_gap_blind_spot）到这一刻才算被事实消解——**但两者的状态是否关闭，
  由维护者决定**（它们是流程盲区，工具本身仍只比时间戳）。

## 4. PR 正文草稿

**标题**

```
第三轮验收控制面收口：写路由严格化、可观测失败身份、仓库级错误审计、上传面定性
```

**正文**

```markdown
## 这个 PR 做了什么

按任务森林第三轮（TF-0252）推进，分两段：

1. **阶段 A+B 整改**（TF-0255~0261）：先让红灯真的能出现，再修生产路径里
   「catch 后继续、把损坏伪装成健康」的路径。
2. **仓库级错误身份审计**（TF-0261 sweep）：清点 packages/workbench/src 的
   140 个 catch 站点，逐站点给出四列结论，并修掉其中 6 条静默失败。
3. **接力交接的上传面定性**（TF-0268 / ADR-0020）：把「哪些产物该上传」写成
   机器可读的定性 + 双向门禁。

## 落库的节点（合并后从「分支上完成」变为「已落库」）

TF-0256 · TF-0257 · TF-0258 · TF-0260 · TF-0261 · TF-0268

## 验证读数（区分有效/无效）

| 门禁 | 读数 |
| --- | --- |
| typecheck / lint | exit 0 |
| 相关测试 | 见下方逐轮报告 |
| 三套件全量 | （在无沙箱 shell 里填） |

逐轮报告：
- docs/handoff/qa-stage-ab-remediation-2026-09-25.md
- docs/handoff/2026-09-25-upload-surface-round.md
- docs/handoff/2026-09-25-catch-after-continue-audit.md
- docs/handoff/2026-09-25-tf0269-silent-failures.md

## 明确没做

- **不发布**：版本 / CHANGELOG / tag / Release 是 TF-0266，需要维护者拍板。
- **不补 TF-0255 的浏览器执行**：需要真实 Chromium 与 CI 接线，本机沙箱起不来。
- **不补 TF-0269 剩的 2 条**：需要真实子进程（见该轮报告 §5）。
- **不裁决上传面的 6 条 referenced-but-local**：需维护者逐条决定。
```

## 5. 不要做的事

| 不要 | 为什么 |
| --- | --- |
| 不要为了让 `check-landing` 变绿而删 done 节点或改状态 | 那是在把测量结果改成想要的答案。缺口是事实，不是读数错误 |
| 不要在 CI 里跳过三套件 | 本轮全部工程结论都建立在"本地拿不到有效读数"上，CI 是唯一补证机会 |
| 不要用 `--allow-stale` apply 旧提案 | 森林图已被本轮三次提案改过；旧提案的 base hash 对不上就是真的对不上 |
| 不要顺手打 tag / 发 Release | TF-0266 是独立节点，且是不可逆动作 |
| 不要把 JihuLab 快照 ref 当成 main | 它是 parent-less 单提交，只为跑 CI 存在 |

## 6. 收口之后仍然开着的（预期）

- **TF-0252 阶段 A 不出口**：TF-0255 的「Playwright 真实执行 + CI 接线 + skip 清理」仍未达成。
- **TF-0252 阶段 B 不出口**：TF-0269 剩 2 条需真子进程（`agents/runner.ts:143`、
  `chat/claude-session.ts:238`）。
- **阶段 C/D/E 未开始**：Codex 写侧验收、发布与跨平台一致性、真人价值窗口。
- **TF-0253 的风险仍然成立**：工程门全绿不等于缺陷已全部解决。
