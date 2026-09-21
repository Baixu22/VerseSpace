# TF-0229 证据链（2026-09-21）

本文件由 `.agent-contexts/tf0229-20260921/evidence-chain-tf0229.py` 生成。下面每个数字都从原始产物里读出来，不手抄；任何一条断言不成立，脚本 exit 1。

## 自检矩阵（不通过即报错）

共 24 项，通过 24 项，失败 0 项。

| 结果 | 自检项 | 实际读数 |
| --- | --- | --- |
| PASS | 静态：tsbx.dll 的导入表里含 SHELL32 的 SHFileOperationW | `SHELL32 导入函数=['CommandLineToArgvW', 'SHFileOperationW', 'SHGetFolderPathW']` |
| PASS | 静态：tsbx.dll 的导入表里不含 RemoveDirectoryW / DeleteFileW（它不是靠 kernel32 删除 API） | `KERNEL32 导入里删除相关=['DeleteCriticalSection']` |
| PASS | 静态：六个 ntdll hook 目标名都在 tsbx.dll 里 | `命中=['NtCreateFile', 'NtOpenFile', 'NtDeleteFile', 'NtQueryAttributesFile', 'NtQueryFullAttributesFile', 'NtSetInformationFile']` |
| PASS | 静态：tsbx.dll 含日志串「File hooks installed: %d/6」 | `needle='File hooks installed' found=True` |
| PASS | 静态：tsbx.dll 含日志串「RECYCLE-BACKUP ok / failed」 | `needle='RECYCLE-BACKUP ok' found=True` |
| PASS | 静态：tsbx.dll 含日志串「BLOCKED modify_backup delete-disp-ex (backup failed)」 | `needle='delete-disp-ex (backup failed)' found=True` |
| PASS | 行为：sandbox 臂 kernel32 非空目录 3/3 被改写（成功 + 哨兵消失 + 14007 + tsbx 已加载） | `[{"pid": 11324, "returned": true, "error": 14007, "keep": false, "tsbx": true, "shell32_before": true, "shell32_after": true, "exit": 1}, {"pid": 17092, "returned": true, "error": 14007, "keep": false, "tsbx": true, "shell32_before": true, "shell32_after": true, "exit": 1}, {"pid": 41336, "returned": true, "error": 14007, "keep": false, "tsbx": true, "shell32_before": true, "shell32_after": true, "exit": 1}]` |
| PASS | 行为：sandbox_bypass 臂同项 3/3 正常（145 + 哨兵存活 + tsbx 未加载） | `[{"pid": 37480, "returned": false, "error": 145, "keep": true, "tsbx": false, "shell32_before": false, "shell32_after": false, "exit": 0}, {"pid": 15768, "returned": false, "error": 145, "keep": true, "tsbx": false, "shell32_before": false, "shell32_after": false, "exit": 0}, {"pid": 21752, "returned": false, "error": 145, "keep": true, "tsbx": false, "shell32_before": false, "shell32_after": false, "exit": 0}]` |
| PASS | 行为：绕过 kernel32 直调 ntdll!NtSetInformationFile(13) 同样 3/3 被改写（NTSTATUS>=0、哨兵消失） | `[{"pid": 11948, "returned": true, "error": 0, "keep": false, "tsbx": true, "shell32_before": true, "shell32_after": true, "exit": 1}, {"pid": 34676, "returned": true, "error": 0, "keep": false, "tsbx": true, "shell32_before": true, "shell32_after": true, "exit": 1}, {"pid": 32224, "returned": true, "error": 0, "keep": false, "tsbx": true, "shell32_before": true, "shell32_after": true, "exit": 1}]` |
| PASS | 行为：同项在 bypass 臂 3/3 返回 0xC0000101 STATUS_DIRECTORY_NOT_EMPTY | `[{"pid": 41648, "returned": false, "error": -1073741567, "keep": true, "tsbx": false, "shell32_before": false, "shell32_after": false, "exit": 0}, {"pid": 40476, "returned": false, "error": -1073741567, "keep": true, "tsbx": false, "shell32_before": false, "shell32_after": false, "exit": 0}, {"pid": 25888, "returned": false, "error": -1073741567, "keep": true, "tsbx": false, "shell32_before": false, "shell32_after": false, "exit": 0}]` |
| PASS | 行为：FileDispositionInformationEx(64) 同样 3/3 被改写 | `[{"pid": 39800, "returned": true, "error": 0, "keep": false, "tsbx": true, "shell32_before": true, "shell32_after": true, "exit": 1}, {"pid": 20856, "returned": true, "error": 0, "keep": false, "tsbx": true, "shell32_before": true, "shell32_after": true, "exit": 1}, {"pid": 29972, "returned": true, "error": 0, "keep": false, "tsbx": true, "shell32_before": true, "shell32_after": true, "exit": 1}]` |
| PASS | 行为：目录里多一个被独占持有的子文件时，sandbox 臂 3/3 删除被拒（ACCESS_DENIED=5、哨兵存活） | `[{"pid": 30324, "returned": false, "error": 5, "keep": true, "tsbx": true, "shell32_before": true, "shell32_after": true, "exit": 0}, {"pid": 35492, "returned": false, "error": 5, "keep": true, "tsbx": true, "shell32_before": true, "shell32_after": true, "exit": 0}, {"pid": 23852, "returned": false, "error": 5, "keep": true, "tsbx": true, "shell32_before": true, "shell32_after": true, "exit": 0}]` |
| PASS | 行为：同条件下 ntdll 入口 3/3 被拒（0xC0000022 STATUS_ACCESS_DENIED、哨兵存活） | `[{"pid": 39932, "returned": false, "error": -1073741790, "keep": true, "tsbx": true, "shell32_before": true, "shell32_after": true, "exit": 0}, {"pid": 45160, "returned": false, "error": -1073741790, "keep": true, "tsbx": true, "shell32_before": true, "shell32_after": true, "exit": 0}, {"pid": 31716, "returned": false, "error": -1073741790, "keep": true, "tsbx": true, "shell32_before": true, "shell32_after": true, "exit": 0}]` |
| PASS | 行为：空目录在两臂都成功（备份机制不改变本来可删的语义） | `{"sandbox": [{"pid": 16400, "returned": true, "error": 14007, "keep": false, "tsbx": true, "shell32_before": true, "shell32_after": true, "exit": 0}, {"pid": 14600, "returned": true, "error": 14007, "keep": false, "tsbx": true, "shell32_before": true, "shell32_after": true, "exit": 0}, {"pid": 41672, "returned": true, "error": 14007, "keep": false, "tsbx": true, "shell32_before": true, "shell32_after": true, "exit": 0}], "bypass": [{"pid": 29796, "returned": true, "error": 126, "keep": false, "tsbx": false, "shell32_before": false, "shell32_after": false, "exit": 0}, {"pid": 35884, "returned": true, "error": 126, "keep": false, "tsbx": false, "shell32_before": false, "shell32_after": false, "exit": 0}, {"pid": 35808, "returned": true, "error": 126, "keep": false, "tsbx": false, "shell32_before": false, "shell32_after": false, "exit": 0}]}` |
| PASS | 行为：sandbox 臂运行的探针进程内 shell32 已加载，bypass 臂未加载（同探针、同夹具，只变 executionMode） | `sandbox_sha=b9a78134ae5b8241409f97f666a596fa4ce10cc346473bc392d5878f2a86ced6` |
| PASS | 对齐：sandbox 臂全部 21 次运行的探针 PID 都有 tsbx 的 RECYCLE-BACKUP 日志 | `sandbox_pids=21 ok=22 fail=6` |
| PASS | 对齐：plain 组合的探针 PID 3/3 出现 `RECYCLE-BACKUP ok` | `plain_pids=['11324', '17092', '41336']` |
| PASS | 对齐：locked 组合的探针 PID 3/3 出现 `RECYCLE-BACKUP failed` | `locked_pids=['23852', '30324', '35492']` |
| PASS | 对齐：每个被托管进程都打印过 `File hooks installed: 6/6` | `hook_pids=45 sandbox_pids=21` |
| PASS | 对齐：bypass 臂的探针 PID 没有任何 tsbx 日志 | `bypass_pids=21` |
| PASS | 对照：普通环境下 7/7 组合都给出 Windows 正常语义（探针本身没坏） | `rows=7 all_normal=True` |
| PASS | 对照：普通环境下探针进程里 tsbx 与 shell32 都未加载 | `tsbx=False shell32=False（7/7）` |
| PASS | 对照：既有探针是 AMD64/PE32+，而 csc 默认产物是 I386/PE32（差异在编译目标平台） | `old=0x8664/0x20b rebuilt=0x14c/0x10b x64=0x8664/0x20b` |
| PASS | 对照：原二进制复现 3/3 + 3/3；同一份源码用 csc 默认选项重编译后 0/3 | `orig=3/3, orig(2nd)=3/3, rebuilt(I386)=0/3` |

## 结论

1. tsbx.dll 静态导入 `SHELL32.dll!SHFileOperationW`，且**没有**导入 `kernel32!RemoveDirectoryW` / `DeleteFileW`；它挂钩的是 ntdll 的六个文件 API（含 `NtSetInformationFile`）。
2. 改写的入口是 **`ntdll!NtSetInformationFile` 的 delete-disposition 分支**（class 13 与 class 64 都被改写），不是 `kernel32!RemoveDirectoryW` 的重路由 —— 绕过 kernel32 直调 ntdll 同样 3/3 被改写。
3. 「删除成功」依赖 tsbx 内部的 **RECYCLE-BACKUP** 成功：把目录里放一个被 `FileShare.None` 独占持有的子文件后，`kernel32` 入口 3/3 变 `ACCESS_DENIED(5)`、`ntdll` 入口 3/3 变 `STATUS_ACCESS_DENIED(0xC0000022)`，哨兵存活。
4. 行为读数与 tsbx 自己的日志逐条对应：`RECYCLE-BACKUP ok` ↔ 删除返回成功、哨兵消失；`RECYCLE-BACKUP failed rc=124` ↔ 删除被拒（ACCESS_DENIED）、哨兵存活。该日志由 tsbx 本身打印，路径就是被删目录。
5. 触发条件还要加一条：**目标进程必须是 x64（PE32+）** 才会被 `direct injection` 真正注入并加载 tsbx。同一份源码只改 `/platform:x64` 就 3/3 复现；csc 默认的 I386/PE32 产物在 sandbox 臂里 `tsbxLoaded=false`、删除语义正常。

## 为什么这不是「路过 tsbx」

判定改写是否「落到具体入口」需要三个条件同时成立，本轮都满足：

1. **入口可枚举**：tsbx.dll 的导入表与字符串里明确列出它挂钩的六个 ntdll 文件 API，其中 `NtSetInformationFile` 是删除的咽喉；它自己打印 `File hooks installed: 6/6`。
2. **只变入口一个变量**：同一次会话、同一夹具、同一探针二进制，把删除入口从 `kernel32!RemoveDirectoryW` 换成 `ntdll!NtCreateFile + NtSetInformationFile`（完全绕过 kernel32），改写行为不变 —— 说明改写点在 ntdll 或之下，而不是 kernel32 之上。
3. **实现可观测**：tsbx 静态导入 `SHELL32!SHFileOperationW`，运行时对每次删除打印 `RECYCLE-BACKUP ok/failed`；把备份做失败后，删除从「成功」翻转为「拒绝」。

## 产物清单（SHA256）

| 路径 | 字节 | SHA256 |
| --- | --- | --- |
| `.agent-contexts\issue-8-fix-2026-09-14\git-host-replay\vendor\5.5.5\package\bin\tsbx.dll` | 694784 | `b6a1573503c9ec5b6fa226063ca0902ec1e5fb5687c5bb0c63183d86679af8c7` |
| `.agent-contexts\tf0229-20260921\mech-CNMKTM\result.json` | 39346 | `6b4f3d6e38bb18ab20bd4cf8301c68c5ac17dae1fc0e648331f00b3ef8bfa621` |
| `.agent-contexts\tf0229-20260921\dbgwin-arm3x64.txt` | 207933 | `24aa13381efcc6f40e266a1865b8bde71c2d6738897e63ed5f16ad0cb038b180` |
| `.agent-contexts\tf0229-20260921\selftest-x64.txt` | 5864 | `f2e940db5ee0ffa0a51e90b55332052fe83e7b9887739d7d6ecb7098072d3c36` |
| `.agent-contexts\tf0229-20260921\legacy-vrsYHN\result.json` | 10927 | `499dcc33551b8991439b9db41a2fd844357d3d6edcadb24e540da92fc094998b` |
| `.agent-contexts\tf0229-20260921\legacy-t1Cloz\result.json` | 10924 | `b14de5b9d800783804aa6b7af3231c496e74473318f206b0396d329610438cb9` |
| `.agent-contexts\tf0229-20260921\legacy-bZJk0M\result.json` | 10943 | `6cf211c095bc845d1cec99438f561bf1573152795b919f11230f0d6cf76b8264` |
| `.agent-contexts\issue-8-fix-2026-09-14\git-host-replay\rmdir-probe.exe` | 4608 | `4aa3c01979b09567f622052a95a13a07f8f3c7f078db18ffb7697332700cd2cf` |
| `.agent-contexts\tf0229-20260921\rmdir-probe-legacy-rebuilt.exe` | 5120 | `b233273912ef853f77f3ec1c8c11910495ad5a295117b5bc91b795de8ba0b6a4` |
| `.agent-contexts\tf0229-20260921\rmdir-probe2-x64.exe` | 8192 | `b9a78134ae5b8241409f97f666a596fa4ce10cc346473bc392d5878f2a86ced6` |
| `.agent-contexts\tf0229-20260921\rmdir-probe2.exe` | 8704 | `ac0eec66636c364e284aaaca5223a1ffb3f5565f41c9ea541db449c53d199575` |
| `.agent-contexts\tf0229-20260921\rmdir-probe2.cs` | 11228 | `4880961ba59c88587e698dbaa60257e976a6f25283cec09da3f0635a4d02d704` |
| `.agent-contexts\tf0229-20260921\replay-mech-arm3.mjs` | 5891 | `e68e2939c43d85a272c78d5ddc606d3dc3b77b1450f4d010b745ba3174439a94` |
| `.agent-contexts\tf0229-20260921\dbgwin-capture.py` | 3780 | `3012a0c5091063bfa59ad12d7add100a5f4430617fbfc28f8f56836c666fb0f8` |
| `.agent-contexts\tf0229-20260921\legacy-vrsYHN\host-state\logs\sandbox\20260921\sandbox_24592.mmap3` | 153600 | `1e517351dc16315a435a0ff10c6e2bfac49f4cd03532c3b14793173f22087b09` |
| `.agent-contexts\tf0229-20260921\legacy-vrsYHN\host-state\logs\sandbox\20260921\sandbox_24592_000.log` | 37291 | `84acf3927314ce45126f2c158426fc88f0d84cdbb5a415148607b6dada76cc77` |
| `.agent-contexts\tf0229-20260921\legacy-vrsYHN\host-state\logs\sandbox\20260921\sandbox_gc_21156_000.log` | 540 | `aac9ff3ea95156be9ac42cd64b995dc24d75d5050d2b22dd9aa1296b7755affd` |
