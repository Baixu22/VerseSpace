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
