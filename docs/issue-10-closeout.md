# Issue #10 收尾：argv 执行回归约定（「注册成功但调用时崩」故障类）

2026-09-15。对照 issue #10 的三条验收标准与 2026-09-15 收尾扫描 §六的 P1 项。

## 收口的是什么

issue #10 不是单点 bug，是**测试设计漏洞**：commander 的 `.action(fn)` 按
`(操作数..., options, command)` 传参，参数个数与操作数个数不匹配时**注册阶段完全正常，
只在调用时崩**。`tribunal shelve <id>`（提交 `d0d9caa` 修复）就是这个故障类——
一个操作数、action 声明四个参数，`command` 拿到 `undefined`，任意 id 必现退出码 1。

旧 `cli.test.ts` 只断言命令树形状（`commands.map(c => c.name())`），对这个故障类完全盲。
本次把**真实执行**变成回归约定。

## 落库内容

`packages/workbench/src/cli.test.ts`：9 项 → **32 项**。三处改动：

1. **`argv execution` 表（19 项 `test.each`）**：每个带操作数的命令一个真实 `parseAsync` 用例。
   树遍历确认workbench 当前**恰好 19 条**带操作数的命令，表格逐条覆盖：
   `goal add/show/cancel`、`decision add`、`interface register`、`sessions show`、
   `premises review-seal`、`tribunal show/shelve/resolve`、`ws create/status/reassign`、
   `checkpoint restore/review`、`dispatch`、`config set`、`context lower/review`。
   每条自带夹具种子（工位 / 检查点 / tribunal 记录）、期望退出码与输出或黑板状态断言。
2. **完整性测试**：遍历 `buildProgram()` 全树，收集 `registeredArguments.length > 0` 的命令，
   与表格的 path 集合严格比对。**新增任何带操作数的命令，此测试立刻失败**——
   不登记执行用例就过不了 CI。
3. **三个零操作数命令的专用用例**：issue 点名的 `sessions record`、`premises seal`、`ui`
   没有操作数（不进表），但各自有独立执行用例：
   - `premises seal --target src/nope.ts` 验证空黑板下正常封印（`--target` 是为了避开 stdin）；
   - `sessions record --writer ... --generated src/a.ts --used src/a.ts` 验证写者注册与活动标签；
   - `ui` 用一个占住 127.0.0.1 临时端口的 `node:net` blocker，断言绑定拒绝——
     `ui` 是长驻服务无法驱动到完成，但拒绝路径足以证明 `(options, command)` 完整到达。

原有的 7 项形状测试与 2 项 argv 先头测试**逐字保留**。

## 为什么是表驱动 + 完整性断言（issue 的方式 2）

issue 给了两个方式。选了方式 2 的完整性骨架 + 方式 1 的真实夹具：

- 纯方式 2（遍历所有命令跑一遍合法 argv）挡不住**每条命令各自的正确性**——
  一个永远合法的 argv 会让错误实现也通过；
- 纯方式 1（逐条手写用例）挡不住**新增命令**——issue 明确要求「新增同类不匹配时测试能挡住」。

所以表格每条都是真实执行（方式 1 的深度），完整性测试保证表格不漏（方式 2 的广度）。

**关键限制（写进注释）**：commander 把每个 `.action(fn)` 包进闭包，
`cmd._actionHandler.length` 对所有命令都是 1——**参数个数无法通过检查树发现，只能调用**。
这是这个故障类的根源，也是为什么完整性测试只能比对「哪些命令有操作数」，
「这些操作数有没有被正确读取」必须靠每条用例真实跑一遍。

## 验证记录

| 验证 | 结果 |
| --- | --- |
| `src/cli.test.ts` | **32 pass / 0 fail**（原 9 项 + argv 表 19 项 + 完整性 1 项 + 专用用例 3 项，其中 1 项替换了原 stdin 读路径） |
| `packages/workbench` 全套 | **690 pass / 0 fail / 1 snapshot / 2662 expect / 106 文件**（基线 667 → +23，与 9→32 的增量一致） |
| `bunx tsc --noEmit` | **exit 0** |
| `bunx biome check` | **clean**（`--write` 修过导入排序与格式后复核） |
| 完整性断言挡住新增命令 | 模拟在 `buildProgram()` 里加 `phantom <id>` → 测试报 `missing: ["phantom"]` |
| 真实不匹配被挡住 | 声明 `<id>` 操作数但 action 从错误位置读 `command.optsWithGlobals()` → `TypeError: command.optsWithGlobals is not a function`，即 `d0d9caa` 的原始故障类 |

## 两项测试套件纪律（本次踩到的坑）

1. **Bun 忽略 `process.exitCode = undefined`**：赋 undefined 不清零，保留上一个非零值。
   合法退出 1 的用例会把退出码泄漏到后续用例。runner 里用 `process.exitCode = 0` 重置、
   `previousExitCode ?? 0` 还原，断言写成 `expect([undefined, 0]).toContain(process.exitCode)`。
2. **不要从测试里读 `process.stdin`**：`sessions record` 不给 `--generated` / `--used` 时读真实 stdin，
   会把共享流搞坏，同进程后续用例报 `ERR_STREAM_PREMATURE_CLOSE`。
   argv 表只走显式路径；stdin 分支仍归 `sessions-record.test.ts` 所有。

另注：`exitOverride()` 必须递归走到整棵树（子命令在创建时复制 `_exitCallback`），
否则 `process.exit(1)` 会把测试运行器一起带走——这条 `d0d9caa` 已有注释，本次沿用了同一封装。

## 验收标准对照

| issue #10 验收标准 | 状态 |
| --- | --- |
| ① 所有带操作数的顶层/子命令都有至少一个真实执行的用例 | ✅ 树遍历确认 19 条，表格逐条覆盖；`test.each` 每条跑真实 `parseAsync` |
| ② 新增同类不匹配时，测试能挡住（可手动制造一个验证） | ✅ 两种方式都验过：加 `phantom <id>` 被完整性测试拦下；真实参数不匹配抛 `TypeError` 被每条用例拦下 |
| ③ workbench 套件全绿 | ✅ 690 pass / 0 fail；tsc 与 biome 均干净 |

**未决（不影响本 issue）**：`agent run` 与 live 通道在本机无活动 agent 凭据（issue #11）。
`dispatch` 用例刻意用一个不存在的 goal 验证结构化拒绝路径（退出码 1 + 「目标不存在」），
不依赖真实模型会话。
