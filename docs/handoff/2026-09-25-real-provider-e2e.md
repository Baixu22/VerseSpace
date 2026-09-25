# 真实 provider E2E 第一次跑通（2026-09-25）

> **双标签口径：真实 provider 证据 +1（脚本驱动，非自然用户）/ 发布物与真人数据仍为零。**
> 凭据：本机 WorkBuddy 网关 `http://127.0.0.1:3065/v1`，模型 `glm-5.3-flash`。
> **密钥只经环境变量传入**——不落盘、不进报告、不进任何提交（脚本自己会 `[REDACTED]`）。
> 分支 `qa-stage-ab-remediation`，改动仅本地 commit，未 push。

---

## 0. 结论摘要

仓库的 E2E 分三类（`apps/workbench-ui/e2e/README.md`）。本轮之前只有第一类有读数。
拿到一组可用的 provider 凭据之后，**第三类第一次真跑，而且通过了**：

| 门禁 | 之前 | 现在 |
| --- | --- | --- |
| Route contract（`test:workbench`） | 1002 pass / 0 fail | 不变 |
| Browser E2E（`test:e2e`） | 13 passed / **1 skipped** | **14 passed / 0 skipped / 0 failed** |
| **Real-provider E2E（`test:live`）** | **从未跑过** | **通过：23 步 / 0 失败 / 37 次模型响应** |

**三类现在都有真实读数。** 但这不等于产品验收——第三类是**脚本驱动**的隔离场景，
报告自己写明了局限（见 §2 末）。

## 1. 凭据与端点（怎么接上的）

| 项 | 值 |
| --- | --- |
| 端点 | `http://127.0.0.1:3065/v1` |
| 支持的形态 | `/v1/responses`（Responses API）与 `/v1/chat/completions` **都可用**；`/v1/models` 显示 `owned_by: workbuddy`，共 12 个模型 |
| 仓库侧的用法 | `E2E_LLM_KEY` + `E2E_LLM_MODEL` + `E2E_LLM_BASE_URL`（三者配套；README 的 live 一节） |
| URL 写法 | `httpEndpoint()` 同时接受基址（`/v1`）与完整端点（`/v1/responses`），所以粘贴哪一种都能跑 |

密钥处理：只在环境变量里传入；`live-run.ts:36` 会把错误信息里的密钥替换成 `[REDACTED]`；
本报告与提交里只有占位符。

## 2. `test:live` 读数（第一次）

```
[live] 通过；模型响应 37 次；请求尝试 37 次
```

| 项 | 值 |
| --- | --- |
| 模型 | `glm-5.3-flash` |
| 步骤 | **23 / 0 失败** |
| 模型响应 | **37 次**（请求尝试 37 次，零重试） |
| 场景 | S0–S11 全过：建线程 / 无卡恢复 / **agent 真进程回合** / **真 LLM 回合** / git 写者并发 / premise_stale 与通知 / 恢复卡 / 分叉+收养+反转 / **封印 block + 人工复核** / 兴趣降低 / 地标认可 / stats / fit 账本 |
| 集成后的开发场景 | 模型**自主修好** endpoint 兼容问题；旧读者恢复、复读并独立复核新实现 |
| 分叉 | 3 个分支（完整 endpoint 与重复斜杠 / 反向代理前缀+query+fragment / 非法 URL+scheme+嵌入凭据） |

stats 读数：

```
threads 5 · restores 2 · sealDecisions 1 · sealBlocked 1 · sealReviewsCorrect 1
noticeOutcomeRows 6 · overlaps 28 · notified 7
restoreToMessage: withCard median 14596ms（1 样本）· withoutCard 36ms（1 样本）· 比值 404%（>20% 为真）
```

**值得单独拎出来的一条：`sealBlocked: 1` + `sealReviewsCorrect: 1`。**
TF-0253 的风险原文写着「seal 可见记录全为 pass / hit=false / blocked=0」——在这个隔离的
脚本场景里，**封印真的挡下了一次写，人工复核也判对了**。这削弱了那条风险的一个前提。
但它不是自然使用读数（手势由脚本驱动），所以**不移动 TF-0267（真人价值窗口）的判据**。

**局限（报告自己写的，照抄）**：模型回复与工具是真实执行；恢复手势、human/git 写者和
复核操作由测试脚本驱动，不代表人工偏好或自然用户体验。

**原始报告不上传**：`calls.jsonl` / `attempts.jsonl` / `live-report.json` 留在临时工作区
（ADR-0020 的 process-evidence）。本文件只带走可复算的读数。

## 3. TF-0255 第 4 条：opt-in 车道也真跑了

`dropdown.spec.ts:76` 的用例默认跳过（需 `WORKBENCH_E2E_CONFIG_SANDBOX=1` 与一个初始化成
`openai-responses` + `high` 的隔离工作区）。本轮把它真跑了：

| 场景 | 读数 |
| --- | --- |
| 隔离工作区（`openai-responses` + `effort: high`）+ 2 个会话，一次跑完 | **14 passed / 0 skipped / 0 failed**（27.7s） |
| 同一工作区跑第二次 | opt-in 用例**失败**：`推理力度` 读到「默认」而非「高」 |

复现步骤：

```bash
mkdir <tmp> && cd <tmp> && bun <repo>/packages/workbench/src/index.ts init
# 把 .workbench/workbench.yaml 的 chat.provider 改成 openai-responses，并加 effort: high
bun <repo>/packages/workbench/src/index.ts ui --port 7700 --no-open &   # cwd 就是这个工作区
bun run dev:ui &
# 播两个会话（POST /api/chat/threads，带 /api/bootstrap 拿到的 token）
cd <repo>/apps/workbench-ui && WORKBENCH_E2E_CONFIG_SANDBOX=1 bun run test:e2e
```

**顺带发现的 harness 性质：这条车道是有状态的。** 用例结尾会把推理力度改回「默认」，
也就是**消费掉自己的前置条件**——同一个工作区跑第二次必然失败。README 写的是
「point `WORKBENCH_E2E_URL` at an isolated workspace initialized with …」，实际含义是
**每次跑都要全新初始化**。两个修法二选一：README 写明「一次性」，或让用例收尾时恢复前置条件。

## 4. TF-0255 现在的状态

| 验收条 | 状态 |
| --- | --- |
| 1. 断言从共享 provider 能力数据推导，不再写死数量 | ✅ |
| 2. CI 在隔离 workspace 中运行浏览器 suite | ❌ **仍未做**：`.gitlab-ci.yml` 里没有 e2e job（也没有 live job）；命令序列已在本机实测通过 |
| 3. 报告区分 passed/failed/skipped，缺前置数据 fail with reason | ✅（上一轮的浏览器 RED/GREEN） |
| 4. 至少覆盖设置 / 草稿切换恢复 / 计划模式 / 窄屏布局 / provider 选择持久化 | ✅（本轮补齐最后一项） |

**只差 CI 接线**，而那一项需要 push 到极狐才能验证——那是维护者的动作。

## 5. 刻意没做

| 没做 | 为什么 |
| --- | --- |
| **不 push / 不发版** | 远程动作与不可逆动作都需要维护者拍板 |
| **不上传原始模型调用日志** | ADR-0020：原始现场是 process-evidence，换机不可复算 |
| **不改 `live-credentials.ts` 的默认模型** | 那个默认值同时决定日常开发用的模型，README 明确说「换不换留给人决定」；本轮只在环境变量里覆盖 |
| **不把 opt-in 用例改成默认运行** | 它需要一个专门初始化的隔离工作区，属于测试环境搭建而非断言修复 |
| **不把这次读数当成产品验收** | 脚本驱动的真实模型调用证明「链路通」，不证明「有人真的这么用」 |

## 6. 复核命令

```bash
# 真实 provider E2E（创建隔离临时工作区，跑完保留现场；约 5–10 分钟）
cd packages/workbench
E2E_LLM_KEY=... E2E_LLM_MODEL=glm-5.3-flash E2E_LLM_BASE_URL=http://127.0.0.1:3065/v1 \
  bun run test:live
# 期望：[live] 通过；模型响应 37 次

# 浏览器 E2E 全量（含 opt-in 车道）——注意工作区要全新
bun packages/workbench/src/index.ts ui --port 7700 --no-open   # cwd = 刚 init 的隔离工作区
bun run dev:ui
cd apps/workbench-ui
WORKBENCH_E2E_CONFIG_SANDBOX=1 WORKBENCH_E2E_URL=http://127.0.0.1:5188 bun run test:e2e
# 期望：14 passed / 0 skipped
```

**本轮的「通过」是工程链路的通过。** 发布物可追溯（TF-0265/0266）、Codex 真实写侧（TF-0262/0264）、
真人价值窗口（TF-0267）三类证据**仍然为零**。
