# context-rot

**context-rot doctor** — 一条命令检测 `AGENTS.md` / `CLAUDE.md` / `.cursorrules`（含 `.cursor/rules/`）里已经失效的代码引用。

356 个代表性仓库中 23.0% 存在陈旧代码元素引用（Treude & Baltes, arXiv:2606.09090）。agent 指引文件的每一条失效断言都会被当作真话，每天、每个会话、每个 agent。

零配置、零 agent、即时输出。

## 用法

```sh
npx context-rot            # 扫描当前目录
npx context-rot ~/some/repo
npx context-rot --json     # 机器可读输出
```

输出：

```
扫描 3 个指引文件：AGENTS.md, CLAUDE.md, .cursorrules
架构断言：57 条   ✔ 有效 54 条   ✘ 已失效 3 条

✘ 已失效引用：
  AGENTS.md:41  `src/agents/old_stream.ts`  路径不存在
  CLAUDE.md:88  `useLegacyComposer`         全库 0 次出现
  AGENTS.md:112 `@helmor/legacy-sdk`        未在任何 package.json 声明
```

退出码：`0` 无失效，`1` 有失效（可直接进 CI），`2` 没有可扫描的指引文件。

## 检测什么

指引文件行内代码 span 里的三类「架构断言」：

| 类型 | 判定 | 失效含义 |
| --- | --- | --- |
| 路径 | 相对仓库根存在性检查 | 引用的文件/目录已删除或改名 |
| 包名 `@scope/name` | 仓库内所有 package.json 的依赖声明 | 依赖已移除 |
| 符号 | 全源码语料全词匹配 | 函数/类/常量已不存在 |

围栏代码块是示例不是断言，跳过；命令、URL、版本号、全小写普通词不可检验，忽略。指引文件自身不参与符号验证（避免自我背书）。

## 不做什么

- 不做语义分析——「引用还存在但意思已经变了」是下一层问题，doctor 只抓确定性的死引用；
- 不读任何配置文件；
- 不联网、不跑 agent、不上传任何东西。

## 足迹采集（hooks）

除了「检测」，context-rot 还提供一个**只观测、绝不阻塞**的 hook：把 agent 对仓库的确定性读写足迹追加到 `.context-rot/footprints.jsonl`。它不阻止任何操作，只为上层功能（如地标、兴趣度）提供数据。

一条命令安装到任意仓库：

```sh
node scripts/install-hooks.mjs            # 安装到当前目录
node scripts/install-hooks.mjs ~/some/repo
node scripts/install-hooks.mjs --uninstall
```

安装器做三件事：

1. 复制 `hooks/footprint.mjs` 到 `.claude/hooks/`；
2. 把 `PostToolUse` hook（`matcher: Read|Write|Edit|Grep|Glob`）合并进 `.claude/settings.json`，**保留你已有的其他 hooks**；
3. 提示把 `.context-rot/` 加入 `.gitignore`（足迹是本地数据）。

### 双宿主：一份配置，两个工具

`.claude/settings.json` 是 Claude Code 的项目级 hooks 配置；**Cursor 开启 Third-party skills 后（Settings → Rules, Skills, Subagents）会自动加载同一份文件**，并把工具名映射到 Cursor 等价物（`Edit→Write`、`Bash→Shell`）。因此足迹脚本无需任何改动即可在两个工具中采集。

| 工具 | 配置来源 | 说明 |
| --- | --- | --- |
| Claude Code | `.claude/settings.json` | 原生加载 |
| Cursor | `.claude/settings.json` | 需开启 Third-party skills；`Glob`/`WebFetch` 工具不触发 |

### 足迹格式

每行一条 JSON，写入 `.context-rot/footprints.jsonl`：

```json
{"ts":"2026-08-31T11:02:23.228Z","session_id":"s1","event":"PostToolUse","tool":"Edit","kind":"write","path":"src/a.ts","host":"claude-code","cwd":"/repo"}
```

- `kind`: `read`（Read/Grep/Glob）或 `write`（Write/Edit/MultiEdit）；
- `path`: 相对仓库根的 POSIX 路径；越出仓库根的引用保留绝对路径；
- `host`: `claude-code` / `cursor` / `unknown`（仅记录，不影响行为）。

设计约束：

- **只记确定性**：Bash/Shell 的命令不猜测，不记录；
- **永不阻塞**：任何错误静默降级，退出码恒为 0；
- **Grep/Glob 无显式目录**时按「对仓库根的宽搜索」记录 `path: "."`。

### Claude Code 插件形态

仓库内 `plugin/` 目录是完整的 Claude Code 插件（`plugin.json` + `hooks/hooks.json` + `scripts/footprint.mjs`），可整体放入 `~/.claude/plugins/`。`scripts/footprint.mjs` 由构建脚本从 `hooks/` 同步，保证单一来源。
