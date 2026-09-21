# TF-0173 证据链（2026-09-21）

本文件由 `.agent-contexts/tf0173-20260921/evidence-chain.py` 生成。下面每个数字都从原始产物里读出来，不手抄；来源缺失即脚本报错，“少一条也过”不算通过。

## 自检矩阵（不通过即报错，不是描述）

共 9 项，通过 9 项，失败 0 项。

| 结果 | 自检项 | 实际读数 |
| --- | --- | --- |
| PASS | sandbox 臂 3/3 复现缺陷：非空目录被删、哨兵消失、tsbx 已加载、exit 1 | `{"parsed": [{"tsbxLoaded": true, "removeNonemptyReturned": true, "error": 14007, "keepExists": false, "removeEmptyReturned": true}, {"tsbxLoaded": true, "removeNonemptyReturned": true, "error": 14007, "keepExists": false, "removeEmptyReturned": true}, {"tsbxLoaded": true, "removeNonemptyReturned": true, "error": 14007, "keepExists": false, "removeEmptyReturned": true}], "exitCodes": [1, 1, 1]}` |
| PASS | sandbox_bypass 臂 3/3 正常：删除被拒 145、哨兵存活、tsbx 未加载、exit 0 | `{"parsed": [{"tsbxLoaded": false, "removeNonemptyReturned": false, "error": 145, "keepExists": true, "removeEmptyReturned": true}, {"tsbxLoaded": false, "removeNonemptyReturned": false, "error": 145, "keepExists": true, "removeEmptyReturned": true}, {"tsbxLoaded": false, "removeNonemptyReturned": false, "error": 145, "keepExists": true, "removeEmptyReturned": true}], "exitCodes": [0, 0, 0]}` |
| PASS | git 切分支连带删除：夹具丢 src/keep.txt，而 git 自身 exit 0 | `{"lost": ["src/keep.txt"], "exitCode": 0, "stderr": "Switched to branch 'main'"}` |
| PASS | 备份打开仍复现（EnableModifyBackup 之前是关的） | `{"enabled": true, "previousEnabled": false}` |
| PASS | 备份关闭仍复现（modifyBackupEnabled=false） | `{"modifyBackupEnabled": false, "passed": false}` |
| PASS | 现场反例成立：加载了 tsbx 但探针通过 | `{"exitCode": 0, "passed": true, "tsbxLoaded": true}` |
| PASS | 加载的 tsbx.dll 与 5.5.5 捆绑件同哈希，且全机只有这一份 | `{"loaded": "9b1f451b83b9ffec8843e361707abd0086138a70ef2a14edd499b5268fd13d95", "bundledTsbxDll": ["9b1f451b83b9ffec8843e361707abd0086138a70ef2a14edd499b5268fd13d95"]}` |
| PASS | 仓库侧无失败：单测 ≥9 例、全量 0 fail | `{"unit": [9, 0], "suite": [913, 0]}` |
| PASS | 转储不含完整堆（minidump），因此无法定位最早写坏点 | `User Mini Dump File: Only registers, stack and portions of memory are available` |

## 结论与它依赖的读数

| 结论 | 判据 | 来源 | 读数 |
| --- | --- | --- | --- |
| 旧 sandbox 托管模式下，删除非空目录返回成功，目录内的文件被一起删掉（Windows 语义应为失败）。 | RemoveDirectoryW 对含 keep.txt 的目录的返回值 + 哨兵是否存活 | `.agent-contexts/tf0173-20260921/mode-zzSkhl/result.json` → `sandbox[0].stdout` | `{"tsbxLoaded": true, "removeNonemptyReturned": true, "error": 14007, "keepExists": false, "removeEmptyReturned": true}` |
| 同一个 sandbox 会话里，git 的删除/切分支清理会连带删掉无关文件与 ref，而 git 自身退出 0。 | 夹具保留文件与 ref 文件是否还在 | `.agent-contexts/tf0173-20260921/switch-kKd8vp/result.json` → `native.files / sandboxed.files / matchesNative` | `{"nativeFiles": 2, "sandboxedFiles": 1, "lost": ["src/keep.txt"], "matchesNative": false}` |
| 开关是「子进程是否以 executionMode=sandbox 被托管启动」，不是「进程里有没有 tsbx.dll」。 | 同会话、同 runtime、同探针、同夹具，只改 executionMode | `.agent-contexts/tf0173-20260921/mode-zzSkhl/result.json` → `sandbox[*]` | `{"parsed": [{"tsbxLoaded": true, "removeNonemptyReturned": true, "error": 14007, "keepExists": false, "removeEmptyReturned": true}, {"tsbxLoaded": true, "removeNonemptyReturned": true, "error": 14007, "keepExists": false, "removeEmptyReturned": true}, {"tsbxLoaded": true, "removeNonemptyReturned": true, "error": 14007, "keepExists": false, "removeEmptyReturned": true}], "exitCodes": [1, 1, 1]}` |
| 备份/回收站通道不是触发条件：开也复现、关也复现。 | modifyBackupEnabled 两种取值下的 matchesNative / passed | `.agent-contexts/tf0173-20260921/switch-p9qvvj/result.json` → `backup + matchesNative` | `{"backup": {"enabled": true, "previousEnabled": false}, "matchesNative": false, "sandboxedFiles": 1}` |
| 反例：当前宿主 shell 已加载 tsbx.dll，文件系统语义却是正常的。 | 同进程内 GetModuleHandleW(tsbx.dll) + 同脚本探针退出码 | `.workbuddy/_tf0173_env.txt` → `tsbxLoaded / Elevated / PSVersion` | `{"tsbxLoaded": "True", "Elevated": "False", "ModuleCount": "85", "PID": "11776"}` |
| 「换掉 tsbx.dll 就能修」不成立：当前进程加载的就是 5.5.5 捆绑的那一份，全机唯一，逐字节相同。 | 已加载模块路径的 SHA256 vs 捆绑目录内文件的 SHA256 | `.workbuddy/_t0173_tsbx.txt` → `LOADED_* / CAND / ALL` | `{"loadedPath": "D:\\software\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\vendor\\sandbox\\5.5.5\\tsbx.dll", "loadedSha256": "9b1f451b83b9ffec8843e361707abd0086138a70ef2a14edd499b5268fd13d95", "distinctBundledSha256": ["9b1f451b83b9ffec8843e361707abd0086138a70ef2a14edd499b5268fd13d95"]}` |
| 仓库侧围堵已落地并接在产品唯一的 git 派生点上，且宿主健康时惰性。 | 代码存在 + 单测 9 例 + 全量套件读数 | `packages/workbench/src/git/host-filesystem.ts / packages/workbench/src/git/host-filesystem.test.ts / packages/workbench/src/git/index.ts` → `文件 SHA256` | `{"packages/workbench/src/git/host-filesystem.ts": "0e4aeb0e0bfdaa9804459ee79a0cb59e24062ca89529cc22c995019d97c94a0d", "packages/workbench/src/git/host-filesystem.test.ts": "a2fc81227f3789957a23fa070efdb0c043dde0f8931d808de2ea29a9ab97b800", "packages/workbench/src/git/index.ts": "62a6ef7be7532e2580488e4d665fb55dd34149628f1f4236ae230c081dc9bd17"}` |
| 三次历史 0xC0000374 的「最早写坏点」仍未被证明——转储不含完整堆。 | 转储标志与检测栈只证明经过，不证明首次写坏 | `.agent-contexts/tf0173-20260921/git.exe.14216.dmp` → `bytes / sha256` | `{"bytes": 2872709, "sha256": "dbe70fc30a0d4f63be8be2f4901fb69860ac52d04b4bf4c3e5fc4b7505a786ca"}` |

## 逐条展开

### L1-a

旧 sandbox 托管模式下，删除非空目录返回成功，目录内的文件被一起删掉（Windows 语义应为失败）。

- 判据：RemoveDirectoryW 对含 keep.txt 的目录的返回值 + 哨兵是否存活
- 来源 `.agent-contexts/tf0173-20260921/mode-zzSkhl/result.json` → `sandbox[0].stdout`：`{"tsbxLoaded": true, "removeNonemptyReturned": true, "error": 14007, "keepExists": false, "removeEmptyReturned": true}`
- 来源 `.agent-contexts/tf0173-20260921/no-recycle-xvVkdt/result.json` → `rmdir.stdout`：`{"tsbxLoaded": true, "removeNonemptyReturned": true, "error": 14007, "keepExists": false, "removeEmptyReturned": true}`

### L1-b

同一个 sandbox 会话里，git 的删除/切分支清理会连带删掉无关文件与 ref，而 git 自身退出 0。

- 判据：夹具保留文件与 ref 文件是否还在
- 来源 `.agent-contexts/tf0173-20260921/switch-kKd8vp/result.json` → `native.files / sandboxed.files / matchesNative`：`{"nativeFiles": 2, "sandboxedFiles": 1, "lost": ["src/keep.txt"], "matchesNative": false}`
- 来源 `.agent-contexts/tf0173-20260921/no-recycle-xvVkdt/result.json` → `public.stdout(passed)`：`{"passed": false, "nonemptyDirectory": {"removeReturned": true, "win32Error": 14007, "keepExists": false}, "gitState": {"targetExists": false, "refs": [{"ref": "refs/heads/ws/probe", "correct": false}, {"ref": "refs/remotes/origin/main", "correct": false}], "keepExists": false}}`

### L1-c

开关是「子进程是否以 executionMode=sandbox 被托管启动」，不是「进程里有没有 tsbx.dll」。

- 判据：同会话、同 runtime、同探针、同夹具，只改 executionMode
- 来源 `.agent-contexts/tf0173-20260921/mode-zzSkhl/result.json` → `sandbox[*]`：`{"parsed": [{"tsbxLoaded": true, "removeNonemptyReturned": true, "error": 14007, "keepExists": false, "removeEmptyReturned": true}, {"tsbxLoaded": true, "removeNonemptyReturned": true, "error": 14007, "keepExists": false, "removeEmptyReturned": true}, {"tsbxLoaded": true, "removeNonemptyReturned": true, "error": 14007, "keepExists": false, "removeEmptyReturned": true}], "exitCodes": [1, 1, 1]}`
- 来源 `.agent-contexts/tf0173-20260921/mode-zzSkhl/result.json` → `sandbox_bypass[*]`：`{"parsed": [{"tsbxLoaded": false, "removeNonemptyReturned": false, "error": 145, "keepExists": true, "removeEmptyReturned": true}, {"tsbxLoaded": false, "removeNonemptyReturned": false, "error": 145, "keepExists": true, "removeEmptyReturned": true}, {"tsbxLoaded": false, "removeNonemptyReturned": false, "error": 145, "keepExists": true, "removeEmptyReturned": true}], "exitCodes": [0, 0, 0]}`

### L1-d

备份/回收站通道不是触发条件：开也复现、关也复现。

- 判据：modifyBackupEnabled 两种取值下的 matchesNative / passed
- 来源 `.agent-contexts/tf0173-20260921/switch-p9qvvj/result.json` → `backup + matchesNative`：`{"backup": {"enabled": true, "previousEnabled": false}, "matchesNative": false, "sandboxedFiles": 1}`
- 来源 `.agent-contexts/tf0173-20260921/no-recycle-xvVkdt/result.json` → `rules.modifyBackupEnabled + public.passed`：`{"modifyBackupEnabled": false, "passed": false}`

### L1-e

反例：当前宿主 shell 已加载 tsbx.dll，文件系统语义却是正常的。

- 判据：同进程内 GetModuleHandleW(tsbx.dll) + 同脚本探针退出码
- 来源 `.workbuddy/_tf0173_env.txt` → `tsbxLoaded / Elevated / PSVersion`：`{"tsbxLoaded": "True", "Elevated": "False", "ModuleCount": "85", "PID": "11776"}`
- 来源 `.workbuddy/_tf0173_probe.txt` → `EXITCODE + passed + nonemptyDirectory + tsbxLoaded`：`{"exitCode": 0, "passed": true, "tsbxLoaded": true, "nonemptyDirectory": {"removeReturned": false, "win32Error": 145, "keepExists": true}, "gitState": {"targetExists": false, "refs": [{"ref": "refs/heads/ws/probe", "correct": true}, {"ref": "refs/remotes/origin/main", "correct": true}], "keepExists": true}}`

### L1-f

「换掉 tsbx.dll 就能修」不成立：当前进程加载的就是 5.5.5 捆绑的那一份，全机唯一，逐字节相同。

- 判据：已加载模块路径的 SHA256 vs 捆绑目录内文件的 SHA256
- 来源 `.workbuddy/_t0173_tsbx.txt` → `LOADED_* / CAND / ALL`：`{"loadedPath": "D:\\software\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\vendor\\sandbox\\5.5.5\\tsbx.dll", "loadedSha256": "9b1f451b83b9ffec8843e361707abd0086138a70ef2a14edd499b5268fd13d95", "distinctBundledSha256": ["9b1f451b83b9ffec8843e361707abd0086138a70ef2a14edd499b5268fd13d95"]}`

### L1-g

仓库侧围堵已落地并接在产品唯一的 git 派生点上，且宿主健康时惰性。

- 判据：代码存在 + 单测 9 例 + 全量套件读数
- 来源 `packages/workbench/src/git/host-filesystem.ts / packages/workbench/src/git/host-filesystem.test.ts / packages/workbench/src/git/index.ts` → `文件 SHA256`：`{"packages/workbench/src/git/host-filesystem.ts": "0e4aeb0e0bfdaa9804459ee79a0cb59e24062ca89529cc22c995019d97c94a0d", "packages/workbench/src/git/host-filesystem.test.ts": "a2fc81227f3789957a23fa070efdb0c043dde0f8931d808de2ea29a9ab97b800", "packages/workbench/src/git/index.ts": "62a6ef7be7532e2580488e4d665fb55dd34149628f1f4236ae230c081dc9bd17"}`
- 来源 `.workbuddy/_t0173_recheck2.log` → `单测 pass/fail`：`{"pass": 9, "fail": 0}`
- 来源 `.workbuddy/_t0173_full_suite.log` → `全量 pass/fail`：`{"pass": 913, "fail": 0}`

### L3-未证

三次历史 0xC0000374 的「最早写坏点」仍未被证明——转储不含完整堆。

- 判据：转储标志与检测栈只证明经过，不证明首次写坏
- 来源 `.agent-contexts/tf0173-20260921/git.exe.14216.dmp` → `bytes / sha256`：`{"bytes": 2872709, "sha256": "dbe70fc30a0d4f63be8be2f4901fb69860ac52d04b4bf4c3e5fc4b7505a786ca"}`
- 来源 `.agent-contexts/tf0173-20260921/evidence-summary.json` → `dumpFlags / command / crashPid`：`{"dumpFlags": "0x200121", "command": "git.exe switch main", "crashPid": 14216, "dumpBytes": 2872709}`
- 来源 `.agent-contexts/tf0173-20260921/heap-details.txt` → `dump 头一行`：`User Mini Dump File: Only registers, stack and portions of memory are available`

## 证据产物清单（SHA256）

| 路径 | 字节 | SHA256 |
| --- | --- | --- |
| `.agent-contexts/tf0173-20260921/evidence-summary.json` | 405 | `7b63b86b46a2c681d53506b2432fb5b5788c4fee24997e4faf1a8f18a5a7d5c7` |
| `.agent-contexts/tf0173-20260921/git.exe.14216.dmp` | 2872709 | `dbe70fc30a0d4f63be8be2f4901fb69860ac52d04b4bf4c3e5fc4b7505a786ca` |
| `.agent-contexts/tf0173-20260921/heap-details.txt` | 4714 | `e5950aba2d5b89f8c90bc4cc559c28d84eb5f5e6a9d8055c24feda406424b5bf` |
| `.agent-contexts/tf0173-20260921/heap-block.txt` | 18417 | `814d3d86b346eaef81169f6965b3b9791305d114d762d04a99f5799e785af03e` |
| `.agent-contexts/tf0173-20260921/analysis.txt` | 81989 | `19b3c0469d6769275ff0deb488c89e653065fce8cc281a4b1af977cf331e699b` |
| `.agent-contexts/tf0173-20260921/host-correlation.txt` | 128125 | `e7e77c4e50f623e12c1f6b209ffe222d3c3e844126a019d96e0fcd886b192cca` |
| `.agent-contexts/tf0173-20260921/report.wer` | 34082 | `38a815251e0dc140ec815345781309c5ae5aa09764a8c2f9a74c4a3f0657f666` |
| `.agent-contexts/tf0173-20260921/replay-execution-mode.mjs` | 3284 | `d7a1ae75161dc470fc28d57db5553cb854568db7794a602a07c493d53067a3c9` |
| `.agent-contexts/tf0173-20260921/replay-no-recycle.mjs` | 1540 | `63ea1ee1f864a17197fab5b56d30b7d30a9ca1fc8af85021b7a730cc8d185754` |
| `.agent-contexts/tf0173-20260921/replay-switch.mjs` | 4142 | `3aa7928ed54f33fd77751127460d166237e62bdd06a5cca8912ccbf7337bf3aa` |
| `.agent-contexts/tf0173-20260921/replay-copyhooks.mjs` | 684 | `5202edebe314c70d5d3830914d691ca09bc6dea00d2ac2dac7096d86060bdd81` |
| `.agent-contexts/tf0173-20260921/small-switch-replay.log` | 197 | `a1cc8eb7aee6492e3211c772c788f28a3fadee3fc81bd05bfb07a3196b2e3d57` |
| `.agent-contexts/tf0173-20260921/switch-replay.log` | 32505 | `e9d11860e30a42d224b8d229ab11f1c7d3789ab0b373927e3c6bacacdd63f8f9` |
| `.agent-contexts/tf0173-20260921/followup-proposal.json` | 7320 | `a9c9c974bfe106d68b382ba0b9e209863c55f791b1f2c336408da057be629154` |
| `.agent-contexts/tf0173-20260921/copyhooks-ncqlTg/result.json` | 2679 | `f98874540aa5da0075a43676ef06e69311bd4b4ccef03ca0dc9c8633181fc091` |
| `.agent-contexts/tf0173-20260921/mode-9pJuku/result.json` | 8134 | `86a8283fba59e71ab272da8888f994c699c6d28fb9f15d7fc5469c69d060fe72` |
| `.agent-contexts/tf0173-20260921/mode-ThdDbe/result.json` | 8006 | `076e09837318a8839a70cbb6d546444d8ee0a41ee8df240d0b1242b666840f22` |
| `.agent-contexts/tf0173-20260921/mode-vSTFmV/result.json` | 7894 | `ad1eac0bde7cb5266cea9df0c2aa874e9cd09f588d8c20849df21818a423ef26` |
| `.agent-contexts/tf0173-20260921/mode-zzSkhl/result.json` | 8735 | `a177cbcc06256f96b3aac7f964522629540aec3b940a7c589a1424399821712b` |
| `.agent-contexts/tf0173-20260921/no-recycle-DkT615/result.json` | 7834 | `f16d3022a6ab61b87b24dbf39ccb166c54a02e330ab107def4f134a166020349` |
| `.agent-contexts/tf0173-20260921/no-recycle-xvVkdt/result.json` | 12800 | `88d32bc6c5815e5fbe9216bc024eb3906793ac1948e5bd7e12f6f78f3565f6f5` |
| `.agent-contexts/tf0173-20260921/switch-TZ3JzW/result.json` | 35149 | `8f116b15d8c31b0e655a93153d4f46b9b4dcd02428fa839d369540e8ee5b56ab` |
| `.agent-contexts/tf0173-20260921/switch-kKd8vp/result.json` | 823 | `b5573fb89af43c2443228ab48920958b74455424cef30fa6701a3165c6a6dbc8` |
| `.agent-contexts/tf0173-20260921/switch-p9qvvj/result.json` | 892 | `8c3d3daa36b09c7944602eb92cb42b6f05c3b168b54836a04d98d6a8e317aca8` |
| `packages/workbench/src/git/host-filesystem.ts` | 8992 | `0e4aeb0e0bfdaa9804459ee79a0cb59e24062ca89529cc22c995019d97c94a0d` |
| `packages/workbench/src/git/host-filesystem.test.ts` | 5394 | `a2fc81227f3789957a23fa070efdb0c043dde0f8931d808de2ea29a9ab97b800` |
| `packages/workbench/src/git/index.ts` | 2851 | `62a6ef7be7532e2580488e4d665fb55dd34149628f1f4236ae230c081dc9bd17` |

夹具目录（`switch-*/`、`no-recycle-*/`、`mode-*/`、`copyhooks-*/`、`native-copyhook-fixture/`）连同宿主 state、ipc-events.jsonl、manager.log 原地保留在 `.agent-contexts/tf0173-20260921/`，该目录由本机 `.git/info/exclude` 排除，不上传。

## 复算方式

```bash
# 1) 重跑本证据链（会校验每条来源存在并重新计算全部 SHA256）
python3 .agent-contexts/tf0173-20260921/evidence-chain.py

# 2) 现场探针（当前宿主是否安全）
powershell.exe -NoProfile -File scripts/win/check-git-filesystem.ps1

# 3) 单变量对照（会重新触发旧宿主缺陷，只在新夹具里跑）
bun .agent-contexts/tf0173-20260921/replay-execution-mode.mjs

# 4) 仓库侧闸门测试
cd packages/workbench && bun test --timeout 60000 src/git/host-filesystem.test.ts
```

## 覆盖边界（明确没证什么）

1. **sandbox 模式内『谁』把删除变成成功**——未定位。目前只有调用链层面的怀疑（转储检测栈经过 `SHFileOperation → CFileOperation::FinishOperations`），缺机制级单变量。
2. **三次历史 `0xC0000374` 的最早写坏点**——未证。转储为 minidump，检测栈只能证明「经过」；旧三次 `git apply` 的转储仍缺失。
3. **旧宿主上 git 的其它路径**（`git apply` 大规模补丁）——只有历史记录，本轮未复跑；960 文件那次超时，不计入证据。
