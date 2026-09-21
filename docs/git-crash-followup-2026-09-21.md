# Git 堆损坏：新转储与宿主对照（2026-09-21）

关联任务：TF-0173；前序证据见 [Issue #8 调查](issue-8-crash-investigation.md)。

## 本轮结论

“没有新的 Git 转储”已不再成立。本机保留了 2026-09-20 的 Git 2.51.0.1
堆损坏转储，命令为 `git.exe switch main`，PID 14216。检测线程通过
WorkBuddy 的 `tsbx.dll` 进入 Windows 外壳文件操作。当前旧宿主中的隔离实验
仍复现“Git 返回成功但删除了不该删除的文件”。原生宿主的相同操作正常。

这些证据足以否定“切换 Git 版本或退休 Rust 后问题自然消失”，但不能把
堆损坏检测位置当成最早写坏内存的位置。TF-0173 保持 blocked，阻塞原因更新为
缺少完整堆证据和可验证的宿主修复；不再沿用“完全没有新转储”的旧描述。

## 已保存的证据

- Windows Application 1000 / WER 1001：记录 1242921、1242922，2026-09-20
  16:31:56–16:31:59（UTC+8），异常 `0xC0000374`，报告
  `7bb5464e-8dc7-4675-8618-f3519f879d1b`。
- 转储 `git.exe.14216.dmp`：2,872,709 字节，SHA256
  `dbe70fc30a0d4f63be8be2f4901fb69860ac52d04b4bf4c3e5fc4b7505a786ca`。
  标志 `0x200121`，不含完整进程内存。
- 使用 Windows 自带 DbgEng 读取转储，以对应 Microsoft 公共 PDB 解析 Windows
  栈；从 PEB 读取到命令 `git.exe switch main`。
- 检测栈：`tsbx+0x13fbc` → `SHFileOperationWithAdditionalFlags` →
  `CFileOperation::FinishOperations` → 路径解析与分配 → `RtlpLogHeapFailure`。
  其他线程同时经过 `CanDeletePath`、`tsbx` 和外壳复制钩子路径。
- 加载模块包括旧 WorkBuddy 5.5.5 配套 `tsbx.dll`、`MFCopyHook.dll` 和
  `NsCopyHook3.dll`。仅凭加载记录不能断言其中任何一个模块写坏了堆。
- 旧宿主日志中相同 PID 的 `ModifyBackup` 请求与响应共 492 行，时间范围为
  16:31:36.108–16:31:59.045，与崩溃窗口相符。

原始转储、WER、符号和宿主日志只保存在本地
`.agent-contexts/tf0173-20260921/`，已通过本机 `.git/info/exclude` 排除，不上传到 PR。

## 现场对照

所有写入实验都使用新建隔离夹具，没有在真实工作树中复现删除故障。

| 实验 | 结果 |
| --- | --- |
| 当前原生宿主运行 `scripts/win/check-git-filesystem.ps1` | exit 0；未加载 tsbx；非空目录、兄弟文件、嵌套分支及 remote ref 均保留 |
| 旧 WorkBuddy 5.5.5 配套运行时运行同一脚本 | exit 1；加载 tsbx；非空目录删除成功，兄弟文件及两个 ref 丢失 |
| 新进程运行已有外壳删除探针 | 128 次删除，0 失败；两个已隔离钩子和 tsbx 均未加载 |
| Git 切分支：8 个目录、每目录 3 个临时文件 | 原生切换后保留 2 个文件；旧宿主 exit 0、输出切换成功，却仅剩 1 个，`src/keep.txt` 丢失 |
| Git 切分支：80 个目录、每目录 12 个临时文件 | 原生完成；旧宿主超过 45 秒进程限额后仍未完成，夹具处于部分变更状态；此项不能当成已复现堆崩溃 |

现有用户级外壳隔离注册仍为空且原生探针生效。9 月 20 日转储却加载了两钩子，
不能由当前注册状态倒推当时的实际隔离状态，也不能声称用户级设置覆盖了所有宿主进程。

## 处理边界与继续条件

当前 Codex 原生宿主经过文件系统探针，能继续完成本仓库 Git 工作。
保留现有外壳隔离、`git rm --cached` 的窄规避和宿主探针；没有恢复 Rust/Tauri，
没有向 Git 或 Workbench 加入掩盖问题的重试，没有修改系统防护或替换 WorkBuddy 安装文件。

完全关闭 TF-0173 仍需满足以下之一所需的完整因果与验证链：在隔离宿主中捕获
最早非法堆写入及完整转储，定位责任实现并验证修复；或取得兼容的正式宿主修复，
结合直接故障证据完成修复前后的同条件对照。旧三次 `git apply` 的缺失转储仍然缺失，
不能宣称它们与此次 `git switch` 的内存写坏点完全相同。

## 2026-09-21 现场复核：判据是行为，不是模块

本轮重新对齐三项现场读数（同一台机器、同一个宿主进程）：

| 项 | 读数 |
| --- | --- |
| 现场配置 | Windows PowerShell 5.1.26100.7920（x64），进程已加载 85 个模块 |
| 提权状态 | `Elevated=False`（非管理员） |
| 旧沙箱行为 | **`tsbx.dll` 已加载**；`MFCopyHook.dll`、`NsCopyHook3.dll` 均未加载 |

在**这个加载了 `tsbx.dll` 的宿主**里运行 `scripts/win/check-git-filesystem.ps1`：**exit 0**。

- `RemoveDirectoryW` 对非空目录返回 `false`、Win32 错误 `145`，目录里的哨兵文件存活；
- `git rm -- src/delete.txt` 退出 0，兄弟文件 `src/keep.txt` 仍在；
- `refs/heads/ws/probe` 与 `refs/remotes/origin/main` 都写成了，且都指向 HEAD。

所以「进程加载了 `tsbx.dll`」**不是**复现判据——本机就有一个现成反例。真正的判据是
「非空目录能不能被删掉」，即旧 sandbox 运行时的**文件操作通道是否生效**，而不是模块名是否
出现在模块列表里。这条修正同时否掉了把「加载了 tsbx」直接当作因果证据的写法。

## 仓库侧规避：落在 Git 执行路径上

最早非法堆写入仍捕不到（转储标志 `0x200121`，不含完整进程内存），因此本轮不宣称已定位责任
实现，改为把已确认的**行为缺陷**挡在产品的 git 派生点上：

- 新增 `packages/workbench/src/git/host-filesystem.ts`：进程内执行与 PowerShell 探针同形的
  检查（建非空目录 → 删 → 看哨兵是否存活），只看文件副作用、不看错误码；结论按进程缓存。
- `packages/workbench/src/git/index.ts` 的 `git()` 是产品唯一的 git 派生点，现在先过闸门：
  判定为 `unsafe` 时放行只读动词，拒绝可写动词并返回显式失败报文（点名 TF-0173 与文档）。
- 判定不出来（`indeterminate`）**不拦**；宿主健康时闸门完全惰性——本机 `git()` 行为零变化，
  由既有 904 例与新测试共同覆盖。
- `WORKBENCH_GIT_HOST_GUARD=off` 关闭闸门；`force-unsafe` / `force-clean` 供测试构造判定。

这是**围堵**，不是修复：它把「git 退出 0、文件却已被连带删除」换成一条失败的报错，不改变
外部宿主的语义，不恢复 Rust/Tauri，也不加掩盖问题的重试。TF-0173 保持 blocked，验收条件与
`next_action` 不变。

## 重新定位：触发开关是「sandbox 执行模式」，不是「进程里有 tsbx.dll」

本轮补了两组对照，把「触发条件」从模块名缩到具体一步。

### 对照 A：备份/回收站开关不是触发条件

| 组 | 状态 | 结果 |
| --- | --- | --- |
| `switch-p9qvvj` | `EnableModifyBackup{enabled:true}`，响应 `previousEnabled:false`（即默认本来就是关的） | `matchesNative=false`，`src/keep.txt` 丢失 |
| `no-recycle-xvVkdt` | 规则导出 `modifyBackupEnabled=false` | 探针 `passed=false`：非空目录删除成功、`keepExists=false`、两个 ref `correct=false` |

**开也坏、关也坏** → 备份通道不是开关。（`no-recycle-DkT615` 的探针 `exit 2` 无输出，是
`rmdir-probe.cs` 的自保守卫——cwd 目录名必须以 `api-fixture-` 开头，否则 `return 2`——不是
被决策通道拦下，该轮不计入对照。）

### 对照 B：单变量 = `executionMode`

`replay-execution-mode.mjs`：**同一个会话、同一个 `sandbox-cli.exe` 5.5.5、同一个探针二进制、
同一个夹具**（目录名合规，落在工作规则内），每个模式重复 3 次，只改 `RunExecutable.executionMode`。

| `executionMode` | 次数 | 探针输出 | 判读 |
| --- | --- | --- | --- |
| `sandbox` | 3/3 | `{"tsbxLoaded":true,"removeNonemptyReturned":true,"error":14007,"keepExists":false,"removeEmptyReturned":true}`，exit 1 | 非空目录被删掉，哨兵消失 —— **缺陷** |
| `sandbox_bypass` | 3/3 | `{"tsbxLoaded":false,"removeNonemptyReturned":false,"error":145,"keepExists":true,"removeEmptyReturned":true}`，exit 0 | 删除被拒（145），哨兵存活 —— **正常** |

枚举取值由 API 报错给出：`expected 'sandbox' or 'sandbox_bypass'`。

**结论**：判据不是「进程里有没有 `tsbx.dll`」，而是**子进程是否以 `executionMode:"sandbox"`
被托管启动**——该模式下模块才被注入并接管文件操作。`sandbox_bypass` 里同一份 DLL 根本不加载，
语义正常。

这条同时解释了 2026-09-21 现场复核的反例：当前宿主 shell 里 `tsbx.dll` 确实已加载
（`GetModuleHandleW` 命中，全机唯一一份，SHA256 `9B1F451B…`，与 5.5.5 捆绑件逐字节相同），
但它的文件语义是对的。**注入 ≠ 接管**；接管发生在 sandbox 执行模式这一层。

由此，旧「修复方式」清单要改写：

- 「关闭旧客户端的文件版本备份/文件操作代理」——**被对照 A 否证**。
- 「不直接替换 `tsbx.dll`」——理由更强：同一个二进制在会话外/绕过模式下正常，换单个 DLL 不修任何东西。
- 「Git/Cargo 操作移出旧 sandbox」——**唯一有对照支撑的方向**，与本轮落地的 `git()` 闸门同源。

### 仍未定位的部分

1. `sandbox` 模式内**是谁**把「删除非空目录」变成成功的（疑似被改路由到外壳删除，
   而不是 `RemoveDirectoryW`）——缺机制级证据。
2. 三次历史堆损坏（`0xC0000374`）与这条删除路径是否同一个写坏点。转储为 minidump、
   不含完整堆，检测栈只证明「经过」，不证明「最早写坏」。这一条维持未证。

