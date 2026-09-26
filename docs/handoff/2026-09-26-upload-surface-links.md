# 上传面断链检查（issue #37 · 2026-09-26）

> **标签：本机实测通过（工程门）。** 改动只在本地工作区，未 commit、未 push。
> 上游：issue #37「[docs][P2] 上传面门禁测不到断链 —— 相对路径写法与错误相对深度都放过」。
> 相关：[ADR-0020](../decisions/0020-relay-handoff-upload-surface.md)（上传面定性）、
> [ADR-0023](../decisions/0023-research-prototype-closeout.md)「上传面引用裁决」（本轮在其下追加 2026-09-26 补记）。

---

## 0. 缺陷与结论摘要

`scripts/check-upload-surface.mjs` 里那条 `referenced-but-local` 是**子串判定**（`text.includes(local)`）：只有当引用方把目标写成仓库相对路径时它才看得见。两类真实断链因此静默通过：

| 类 | 实例 | 旧门禁的表现 |
| --- | --- | --- |
| **相对写法** | ADR 里写 `../positioning-v5.md` | 子串判定找的是「仓库相对写法」那一串（`docs/` 开头 + 文件名），文本里根本没有，判定触发不了 |
| **错误相对深度** | `docs/handoff/qa-stage-ab-remediation-2026-09-25.md` 移入 `docs/handoff/` 后链接没有重算基，24 条全部指向不存在的 `docs/packages/…` | `--strict-references` 仍报 0 条违规、exit 0 |

本轮按 issue 的选项 1 落地：**给门禁加一条独立的相对链接解析检查**，并把仓库当前基线钉进测试。

## 1. 改了什么

| 文件 | 改动 |
| --- | --- |
| `scripts/upload-surface/links.mjs` | 新增。纯解析半部（`extractLinkTargets` / `parseLinkTarget` / `resolveLinkTarget`）+ 落盘半部（`checkRelativeLinks`） |
| `scripts/upload-surface/report.mjs` | 新增。把人类可读 / `--json` 渲染从门禁里拆出来，让门禁回到「测量 + 判决」。**输出逐字节不变**（`fc /b` 比对过 `--lists` 的文本与 `--json` 两份） |
| `scripts/check-upload-surface.mjs` | 接入检查：新违规码 `broken-relative-link`；渲染改为调用 `report.mjs`。376 → 306 行，回到 ~300 行的软上限附近 |
| `scripts/upload-surface/links.test.mjs` | 新增。15 个用例，含 real-repo 基线 |
| `package.json:23` | `test:upload-surface` 改为依次跑 `classify.test.mjs` 与 `links.test.mjs` |
| `docs/decisions/0023-research-prototype-closeout.md` | 在「上传面引用裁决」下追加 2026-09-26 补记；既有「已知盲区」段原文保留，只在其后追加 |

判定规则，逐条写清楚：

1. **只读上传面**：`uploaded` = `git ls-files` ∪ `git ls-files --others --exclude-standard`，即 `git add -A` 会传上去的那一批。**本机遗留（`ignored`）文档不检查**——克隆者看不到它们，门禁的主语是克隆者实际拿到的东西。这条范围决定同时写在门禁输出与 `links.mjs` 头部注释里。
2. 每个 `.md` 提取 `[label](target)`、`[label](<target>)` 与 `![label](target)`；**代码围栏与行内代码里的链接不提取**（那是示例，不是指针）。
3. 目标按**引用文件所在目录**解析，正斜杠规范化，`..` 折叠，末尾斜杠去掉。
4. 目标既不是文件也不是目录 → 违规；解析结果仍以 `../` 开头（逃出仓库根）也算违规——任何克隆都不可能有这个路径，而按宿主机去查反而会变成假绿。
5. 不参与的目标：带 scheme（`http:` / `https:` / `mailto:` / `data:` …）、协议相对 `//host/…`、根绝对 `/…`、纯锚点 `#…`、空目标。解析前剥掉 `#fragment` 与 `?query`，再做百分号解码（`%20` → 空格）；非法转义（孤立的 `%`）退回字面文本。
6. **没有开关**：断链是机械事实，所以默认参与门禁，不受 `--strict-references` 管辖，命中即 exit 1。exit 契约不变：`0` 干净 · `1` 有违规 · `2` 无法测量。

## 2. 读数（全部本机真跑）

`--lists` 路径。本沙箱禁止 node 创建子进程，直接跑 `node scripts/check-upload-surface.mjs` 会 `spawnSync git EPERM` → exit 2，那是本机 caveat，不是缺陷。

| 命令 | 读数 | exit |
| --- | --- | --- |
| `node scripts/check-upload-surface.mjs --lists .agent-contexts/upload-lists` | 上传面 812 个文件 · 本机遗留 202587 个 · 违规 0 条；**相对链接 299 条 · 断链 0 条** | 0 |
| 同上再加 `--strict-references` | 同上；6 条 `referenced-but-local` 仍逐条列为「已裁决」，待裁决 0 条 | 0 |
| 同上再加 `--json` | 新增 `relativeLinks: {"checked":299,"broken":[]}`；既有字段（`status`/`counts`/`violations`/`referenceNotes`/`acceptedReferences`/`policyVersion`）一个没动 | 0 |
| `node scripts/check-upload-surface.mjs`（不给 `--lists`） | 无法测量：git 探针失败（`spawnSync git EPERM`） | 2 |
| `bun run test:upload-surface` | classify 15 pass / 0 fail，links 15 pass / 0 fail | 0 |
| `bun run lint` | Biome 无新增问题 | 0 |

**基线**：**299 条相对链接 · 断链 0 条**（273 条互不相同的 `引用文件 → 解析结果`；其中 8 条目标是目录）。基线钉在 `scripts/upload-surface/links.test.mjs` 的 real-repo 用例：断链必须为空，且解析出的链接数不得少于 200——否则解析器自己坏掉之后「0 条断链」会变成假绿。

> 「本机遗留」这个数会随并发活动漂移（本轮两次重生成之间从 201240 涨到 202587），它不是本轮钉住的读数；**断链 0 条**才是。

### 2.1 首次真跑抓到的那一条（已修）

新检查第一次跑就抓到一条旧门禁看不见的断链：

```
.github/pull_request_template.md → .github/docs/decisions/0018-single-ci-channel-jihulab.md（原文 docs/decisions/0018-single-ci-channel-jihulab.md）
```

`.github/pull_request_template.md:22` 把 ADR 写成了「仓库根相对」的样子，而从 `.github/` 解析（GitHub 渲染同样按文件所在目录解析）指向 `.github/docs/…`，不存在。已改成 `../docs/decisions/0018-single-ci-channel-jihulab.md`。

两点必须点出的诚实性：

- 这条**不在本轮代码改动的写范围内**（`.github/` 不在范围里），由协调方修。修好后基线才真的是 0；修之前门禁如实报 exit 1 / 违规 1 条——那不是误报，是这条检查在干活。
- issue 与任务书都假设「当前仓库 0 条断链」，实测是 **1 条**。规则没有被调过：这条断链是真的，判据是 issue 指定的「按引用文件所在目录解析」，GitHub 的真实行为也是这个。

## 3. 复核命令

```bash
# 清单（git 在 PowerShell/cmd 里可用；不要加 2>&1，git 的 warning 会被并进清单变成假违规）
cmd /c "git ls-files > .agent-contexts\upload-lists\tracked.txt"
cmd /c "git ls-files --others --exclude-standard > .agent-contexts\upload-lists\untracked.txt"
cmd /c "git ls-files --others --ignored --exclude-standard > .agent-contexts\upload-lists\ignored.txt"

node scripts/check-upload-surface.mjs --lists .agent-contexts/upload-lists   # 期望 断链 0 条 · exit 0
bun run test:upload-surface                                                  # 期望 30 pass / 0 fail · exit 0
bun run lint                                                                 # 期望 exit 0
```

一条命令复现「错误相对深度」这一类：把 `docs/handoff/qa-stage-ab-remediation-2026-09-25.md` 里任意一条 `../../packages/…` 改回 `packages/…`，门禁立刻报 `broken-relative-link` 并 exit 1。

## 4. 仍然不覆盖的引用类别

绿只说明**这条检查覆盖的类别**是干净的，不能读成「链接都对」：

- **引用式链接**：`[label][ref]` 加 `[ref]: target` 定义。仓库实测 0 处，但规则不解析。
- **HTML**：`<a href="…">`、`<img src="…">`。仓库实测 0 处（ADR-0023 里出现的那两处是描述本节的散文，且在行内代码里）。
- **带空格且未用 `<…>` 包裹的目标**：那不是合法的行内链接，猜它只会制造假违规，因此不解析。
- **非 `.md` 文件里的路径**：源码注释、JSON、YAML 里的路径不查。
- **锚点是否存在**：`docs/a.md#section` 只校验到 `docs/a.md`；`#section` 指向的标题不存在也报不出来。
- **大小写**：解析走宿主机文件系统。Windows 不区分大小写，所以「只在 Linux 克隆上断」的大小写不一致在这里报不出来。
- **本机遗留文档里的断链**：按 §1 的范围决定刻意不查。
- 外链（`https://…`、`mailto:`、autolink `<https://…>`）不查是**设计**而不是缺口：它们不指向仓库里的路径。

## 5. 刻意没做什么

- **没有改 `referenced-but-local` 的判定**。issue 的选项 2 是把它整个换成解析式判定，但那会把已裁决过的 ADR 与交接记录拉进重写（ADR-0023 原文的理由），而且两条检查问的不是同一个问题：子串判定问「指向的目标是否在上传面内」，解析检查问「目标是否存在」。**两条都留。**
- **没有加 `--strict-links` 之类的开关**。给机械事实加开关，只会让「忘了加开关」变成新的静默通道。
- **没有给断链开例外清单**。`policy.acceptedLocalReferences` 那种具名例外是为「判断题」设计的；一条 404 不该有例外位。
- **没有顺手修 `.github/pull_request_template.md`**：不在本轮写范围内。
- **没有把新检查写进 `docs/handoff/README.md` 的自查段**：该文件不在本轮写范围内（建议后续补一行）。

## 6. 遗留风险

- **real-repo 用例的来源**：先试 `git ls-files`（正常机器可用），本沙箱里 `execFileSync git` 抛 EPERM，于是退回读 `.agent-contexts/upload-lists/` 的清单。两者都不可用时会**失败**而不是静默跳过。
- **`299` 会随文档增长**，所以测试只钉「断链 0 条 + 至少解析出 200 条」，不钉精确条数。
- **`--lists` 清单会过期**：`ignored.txt` 有 20 万行，重生成要几秒；忘了重生成时读数只反映上一次的树。这不是新问题，`referenced-but-local` 一直如此。
- **这条检查只看存在性**，不看语义：把一条链接改成指向另一个**存在但不对**的文件，它报绿。
- **两条检查的假阳性方向不同，别互相顶替。** 子串判定会在**散文里提到**某份本机文档的仓库相对路径时报一条 `referenced-but-local`（哪怕那根本不是指针）。本轮就撞到过：这份记录的初稿为了解释盲区把那串路径原样写了出来，门禁立刻从「6 条已裁决」变成「5 条已裁决 + 1 条待裁决」，`--strict-references` 从 exit 0 变 exit 1。改法是改措辞，不是改判定——判定逻辑本轮照 ADR-0023 原文不动。反过来，解析检查对「指向本机文档」一无所知。两条都要留。
