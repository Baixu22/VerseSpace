# Issue #8：Windows Git 故障归因与复验

更新于 2026-09-15。已复现 Git 误删兄弟文件、嵌套分支和 remote ref 消失，并定位到
WorkBuddy 文件操作模块改变了“非空目录不得删除”的系统行为。SDK 5.6.1 的配套运行时通过文件操作对照，
但尚无经过验证、可直接用于本机 WorkBuddy 5.5.6 的升级方案。
历史三次 Git 堆损坏的原始转储仍然缺失，不能确定写坏堆的模块，issue 保留开放。
此前的外壳扩展隔离继续保留；工程构建正常，Cargo registry 使用原始依赖。

## 原始日志与 Windows 事件

`.workbuddy/tf-scan/test-rust.log` 记录：`boring-sys2` 在原始 `git apply -v --whitespace=fix` 步骤收到退出码
`-1073740940`，即 `0xC0000374`（STATUS_HEAP_CORRUPTION），随后 build script 以 101 退出。
该日志于 2026-09-13 08:23:30 写完，与以下第一条崩溃事件相符。

| 本地时间（UTC+8） | Application Error 记录 ID | 进程 | 异常 | 检测模块及偏移 |
| --- | --- | --- | --- | --- |
| 2026-09-13 08:23:28 | 1241268 | Git 2.51.0.1 | `c0000374` | ntdll 10.0.26100.7920，`0x1176e5` |
| 2026-09-13 09:48:29 | 1241277 | Git 2.51.0.1 | `c0000374` | 同上 |
| 2026-09-13 10:02:21 | 1241280 | Git 2.51.0.1 | `c0000374` | 同上 |

三条 Event ID 1000 均指向 `C:\Program Files\Git\mingw64\bin\git.exe`。
对应 WER Event ID 1001 的记录 ID 为 1241269、1241278、1241281。
这确认了原生 Git 进程发生堆损坏，不能把失败描述成普通补丁冲突、测试超时或仅发生于 Git 2.55。
ntdll 是检测到堆损坏的位置，**不是已经证实的责任模块**。

## 缺失与排除边界

- 逐条检查三个 WER 事件引用的 18 个报告目录、dump 和附件路径：均不存在；当前用户 CrashDumps 目录也没有 Git 转储。
- Windows Defender Operational 日志在 2026-09-13 08:15–10:15 内，没有事件 1116、1117、1121–1124。这个有限查询不能排除所有安全软件或其他干扰。
- `.workbuddy/del-probe.txt` 确实记录了 safe-delete 的 `trash-failed`，但发生在当日 18:08、目标是 Python 探针文件；它不能直接证明上午的原生 Git 崩溃由同一组件引起。
- 当前 ntdll 的固定版本仍是 10.0.26100.7920，与 WER 一致；显示版本字符串为 10.0.26100.8162。不能依据显示字符串就声称升级解决了故障。
- 三个 Git 版本的原生隔离探针、原始 BoringSSL 补丁步骤、全新和默认 target 的完整 Rust 测试此前均通过。下文已在 WorkBuddy 运行时中复现文件损坏；原生通过不能替代宿主对照。

## 历史 Git 归因还缺什么

需要取得当时 Git 崩溃的内存转储，或者在原宿主环境中得到新的可重复失败。
复现后应立即保存 Event 1000/1001 指向的转储与附件，并结合堆异常调用栈、加载模块和文件操作进程记录判断原因。
下文分别记录外壳扩展崩溃与 Git 文件操作异常。它们不能替代原始 Git 转储；
2026-09-15 找到的宿主日志已把其中两次历史 Git 进程与 WorkBuddy 的文件备份调用关联起来。

## 本轮证据

本地目录：`.agent-contexts/issue-6-closeout-2026-09-14/issue8-investigation/`。

- `git-crash-events.json`：六个 Application/WER 事件及其原始字段。
- `wer-artifact-check.json`：18 个引用路径的逐项检查。
- `summary.json`：查询窗口、文件哈希、固定版本和汇总。
- `collect-evidence.ps1`：只读采集与核对入口；不改变系统设置。

当前 Git 可执行文件 SHA256：`755d4896d35663d0ff08924f84507f35236b83d240635b512c519bf43cc71a87`。
原始失败日志 SHA256：`18c5dd3ec410a4454297e53656760a110483b18ae11e027e0153e4850ec80094`。

## 后续：外壳复制钩子的并发崩溃

同日继续检查本机保留的三个 Rust `snapshot-*.exe` 转储。它们的删除调用链经过
`SetFileInformationByHandle → WorkBuddy 5.4.3 tsbx.dll → SHFileOperationWithAdditionalFlags`。
其中 `snapshot-af881fa8ad9cc7eb.exe.11244.dmp` 在 `MFCopyHook.dll → RtlFreeHeap` 上报告堆损坏。
这三个文件是 Rust 测试进程的转储，**不是缺失的 Git 转储**。

新探针在各线程分别初始化 STA、创建独立测试目录，并用 `std::barrier` 同步进入回调；
路径均为绝对路径，删除目标旁放置必须保留的文件。直接回调使用有效的 `FO_MOVE` 源、目标路径；
文件删除使用与上述 `tsbx.dll` 转储一致的 `SHFileOperationW` 标志 `0x654`。
探针进程没有加载 `tsbx.dll`。

| 对照 | 结果 |
| --- | --- |
| 123 同步空间 `MFCopyHook.dll` 2.3.0.0，串行回调 | 16 次通过 |
| 同一 DLL，8 个线程同步回调 | 复现 `0xC0000374`；调试运行也捕获到堆检测断点。并非每轮都失败 |
| 原配置，8 个线程执行实际外壳删除 | 复现 `0xC0000005`，也有通过的轮次 |
| 仅隔离 `MFCopyHook.dll` | 确认它不再加载，但 3 轮中仍有 1 轮访问冲突 |
| 同时隔离 `MFCopyHook.dll` 和 NetSarang `NsCopyHook3.dll` 7.0.0.2 | 3 个新进程各完成 128 次删除，0 失败，两 DLL 均未加载 |
| 保持 123 钩子隔离，仅恢复 NetSarang 钩子 | 再次在 `SHELL32_CallFileCopyHooks` 访问失效对象，保存完整转储 |
| 再次隔离 NetSarang，在相同调试条件下运行 | 128 次删除通过，两个钩子均未加载 |

隔离后的 4 个新进程共完成 **512 次删除**，所有保留文件均存在。
NetSarang 独立 ANSI 回调探针通过；失败发生在外壳共同使用钩子的路径中，尚未定位其具体源码缺陷。
本轮确认的是可重复的扩展隔离效果，不能把有限次数通过解释为上游二进制已修复。

## 已应用的本机缓解

仅为当前 Windows 用户设置以下 COM 注册覆盖：对应 `InprocServer32` 的默认值为一个空字符串。
这样新进程通过外壳操作文件时不会实例化这两个复制钩子。

```text
HKCU\Software\Classes\CLSID\{A622C081-AE71-4458-BC85-CAE641439BFA}\InprocServer32
HKCU\Software\Classes\CLSID\{037DA433-DCF0-480e-9A61-DCE5F59F1F7D}\InprocServer32
```

这会停用 123 同步空间和 NetSarang 的对应文件操作外壳集成；客户端和服务未卸载或停止。
已经加载扩展的旧进程仍可能保留它。常规 `Shell Extensions\Blocked` 列表对此路径无效，
该试验项及新建的空键已撤销；系统级 COM 注册未修改。

原用户级注册均不存在，已先保存原值。应用脚本核对 DLL SHA256，遇到其他版本时拒绝套用；
恢复脚本只还原这两个默认值并移除本轮新建的空键，不覆盖其他注册值。
证据与脚本位于本机 `.agent-contexts/issue-8-fix-2026-09-14/`。需要恢复原外壳集成时，在仓库根目录运行：

```powershell
& .\.agent-contexts\issue-8-fix-2026-09-14\set-copyhook-registration.ps1 -Action Restore -Extension MFCopyHook
& .\.agent-contexts\issue-8-fix-2026-09-14\set-copyhook-registration.ps1 -Action Restore -Extension NsCopyHook3
```

两个 DLL 的 SHA256：

- `MFCopyHook.dll`：`0e487c8fbf2caeb6b857235fa383883ac53db5e96a0a8e598c3aae2ca49f3cde`。
- `NsCopyHook3.dll`：`7df1f93b8a88393b4d24ca2c5d4b71116f3bd414029c1b76648fb33c13d4b69f`。

## 本轮验证与证据

重新核对 Cargo.lock 的归档校验和，活跃 `boring-sys2` 的 951 个归档文件逐字节一致。
在新建隔离目录使用原 Git 2.51 执行 `git init` 和两个原始 `git apply -v --whitespace=fix`，
均退出 0，两个 Kyber 产物存在。没有仓库业务代码变更；没有重跑已通过的完整 Rust 套件。

本机 `.agent-contexts/issue-8-fix-2026-09-14/` 保留：

- `copyhook-probe.cpp`、`run-probe.py`：串行、同步并发和外壳删除探针；Python 驱动为每轮设置 45 秒超时。
- `callback-synchronized.log`、`callback-debug.log`：123 钩子的失败与调用栈；原始进程退出码另存于 `verification-summary.json`。
- `shell-registration-fixed.json`、`shell-registration-crash.dmp`：仅隔离 123 钩子时仍然失败的对照。
- `shell-both-overrides.json`、`netsarang-restored-debug.log`、`netsarang-restored-crash.dmp`、`both-fixed-debug.log`：双隔离、单项恢复、再隔离的结果。
- `copyhook-registration-before.json`、`netsarang-registration-before.json`、`set-copyhook-registration.ps1`：原状态与应用/恢复入口。
- `verify-original-git.py`、`original-git-verification.json`：原始依赖和两个 Git 补丁的验证。

证据目录已加入本机 `.git/info/exclude`，不随仓库分发；内存转储没有上传到 GitHub。
#8 的历史 Git 归因继续保持开放。

## 2026-09-15：复现 Git 文件误删与 ref 消失

在独立目录重建 WorkBuddy 的命名管道客户端，启动本机安装包中的
`cli/vendor/sandbox/5.5.5/sandbox-cli.exe`，由它运行同一个 Git 2.51 二进制。
每个实验使用新建仓库、独立工作目录和独立宿主数据目录。两个外壳复制钩子保持隔离。

| 检查 | 原生 Git / Windows API | 本机 WorkBuddy 5.5.6 捆绑运行时 |
| --- | --- | --- |
| 对含 `keep.txt` 的目录调用 `RemoveDirectoryW` | 返回 false，错误 145；文件保留 | 返回 true，目录和文件被删除 |
| `git branch ws/probe` | ref 存在且指向 HEAD | 退出 0，ref 不存在 |
| `git update-ref refs/remotes/origin/main HEAD` | ref 存在且指向 HEAD | 退出 0，ref 不存在 |
| `git rm -- src/delete.txt` | `src/keep.txt` 保留 | 退出 0，兄弟文件也消失 |
| 第一个原始 BoringSSL 补丁 | 退出 0，产物完整 | 多轮退出 0，却缺失 425 或 740 个文件；另有超时轮次 |

独立 C# 探针只调用 `RemoveDirectoryW`，不使用 Git。原生进程未加载 `tsbx.dll`，
宿主内的进程确认加载了该模块。官方 npm SDK 5.5.5、5.5.7 的同一探针也删除了非空目录。
因此，隔离外壳扩展只能缓解此前的并发崩溃，不能修正这个文件操作缺陷。

Git 2.51 源码解释了这些看似无关的症状：`dir.c::remove_path` 在删除文件后逐层尝试
`rmdir`，遇到非空目录应停止；`refs/files-backend.c::try_remove_empty_parents` 在清理 ref 锁时
也尝试删除空父目录。`compat/mingw.c::mingw_rmdir` 依赖 Windows 的原始目录删除语义。
宿主让非空目录删除成功，使这两种清理操作变成了连带删除。

这次定位不依赖更换 Git、修改 Cargo registry、增加重试或关闭 Windows 防护。
本机安装目录没有被修改。

## 新版运行时与部署边界

从 npm 下载 SDK 5.6.1，并校验注册表提供的 SHA512 integrity；在独立目录启动其配套
`sandbox-center.exe` 和 `sandbox-cli.exe`。该版本不再接受旧的 `AddFileRule` 命令，
需要通过 center 的规则接口配置测试目录。

- 默认配置下，确认加载新版 `tsbx.dll`；非空目录删除正确返回错误 145，两个 ref 和兄弟文件均保留。
- 导出的实际规则仍为 `recyclebin_backup: true`，没有靠关闭删除转回收站功能得到通过结果。
- 默认的内容扫描将 BoringSSL `ssl_test.cc` 中五组公开测试密钥识别为敏感信息，阻止补丁读取。
  该文件 SHA256 为 `9cde5fb8c929aadb01936926ae4aaf5d633be659a15339c41ebcee37be6c5441`，
  与 Cargo.lock 校验的原始 crate 归档一致。
- 为单独验证文件操作，在**仅供本轮实验的 center** 设置 `cipher.detectionEnabled=false`。
  文件权限规则和回收站配置继续生效。两个原始补丁均退出 0；每一步的 **935 个文件**与原生结果逐项哈希一致，
  缺失与不匹配均为 0。这个结果不是“默认安全配置下的完整构建通过”。用户的安全配置没有改变。

不能直接把这份 SDK 放进现有客户端：旧版宿主使用已移除的接口；在安装包副本中仅替换
`tsbx.dll`，以及连同 `tsbx_sdk.dll` 替换的两种尝试，目标进程均在探针运行前以 1 退出。
这些不兼容组合没有部署到安装目录。

查询客户端使用的公开 Windows user-installer 更新源，版本 5.5.6 得到 HTTP 204；
以 0.0.0 查询返回的是较旧的 4.10.4.26327962。查询未带用户或租户标识，不能排除定向灰度渠道。
目前确认的是新版 SDK 已修正这组文件操作行为，仍需匹配的正式客户端及其默认配置下的验证。

## 历史 Git 进程与宿主日志的关联

重新检查 2026-09-13 的 WorkBuddy sandbox 日志，找到与 Windows 崩溃事件相同的 PID 和 BoringSSL 路径：

| Git PID | 崩溃时间（UTC+8） | 宿主日志中的 `ModifyBackup` 请求 |
| --- | --- | --- |
| 33672 | 08:23:28.393 | 1,135 条，最后一条记录于 08:23:28.386 |
| 25320 | 09:48:29.154 | 379 条，包含同一补丁涉及的文件；日志有异步记录延迟 |

这确认两次历史崩溃的 Git 进程经过 WorkBuddy 的文件操作通道。
未在保留日志中找到第三个 PID 27488 的对应请求；原始 Git dump 仍缺失。
不能从“加载或经过该模块”进一步断言三次堆损坏均由同一函数写坏内存。

## 可重复运行的检查

在要验证的宿主终端中、从仓库根目录运行：

```powershell
powershell.exe -NoProfile -File .\scripts\win\check-git-filesystem.ps1
```

[检查脚本](../scripts/win/check-git-filesystem.ps1) 新建独立临时目录，检查非空目录删除、
嵌套 ref、remote ref 和删除目标旁的保留文件；保留现场及 `result.json`，通过退出 0，否则退出 1。
它只操作自建夹具，临时隔离 Git 的全局配置，并在结束时恢复进程环境变量。
不要只看 Git 子命令的退出码；本次故障正是“退出 0，但文件已损坏”。

脚本在原生 Windows PowerShell 5.1 / PowerShell 7 中通过；在旧宿主中退出 1 并捕获全部三类 Git 异常；
在 SDK 5.6.1 的隔离文件操作配置中通过，且确认脚本进程加载了 `tsbx.dll`。

新增证据保存在 `.agent-contexts/issue-8-fix-2026-09-14/git-host-replay/`，不上传内存转储或用户日志：

- `historical-git-correlation.json`：历史 PID、时间、文件路径与宿主日志哈希。
- `rmdir-repro.mjs`、`rmdir-probe.cs`：不依赖 Git 的 Win32 API 对照。
- `git-filesystem-repro.mjs`、`boringssl-repro.mjs`：旧宿主中的 Git / 原始补丁复现。
- `center-repro.mjs`：新版的独立 center、规则、模块加载与逐文件核验；默认配置的内容扫描失败也保留。
- `host-replay-summary.json`：上述结果及对应证据目录的索引。

后续应验证匹配的 WorkBuddy 客户端，并在再次出现 Git 堆损坏时立即采集该 Git 进程的 dump。
