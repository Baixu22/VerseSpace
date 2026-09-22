# TF-0231：宿主注入判据的定位与判定（PE32/AnyCPU 托管程序集不被注入）

- 日期：2026-09-21
- 节点：TF-0231（父 TF-0229 的未解因果之一）
- 原始产物：`.agent-contexts/tf0231-20260921/`（本地保留，`/.agent-contexts/tf0231-*/` 已忽略）
- 探针源码：`.agent-contexts/tf0229-20260921/rmdir-probe2.cs`（SHA256 `4880961ba59c88587e698dbaa60257e976a6f25283cec09da3f0635a4d02d704`，与 TF-0229 同一份，未改动）

## 一句话结论

宿主注入器按 **PE 头的 `AddressOfEntryPoint` 是否为 0** 选择注入路径：为 0 走 APC 回退
（有效），非 0 走 direct injection（对托管程序集**不生效**且**静默**）。
`csc` 的默认 AnyCPU 产物是 PE32、`AddressOfEntryPoint=0x37BE`，因此被托管启动时
**tsbx 根本不加载，沙箱约束完全失效**。判定为**实现缺陷**，不是有意设计——理由是宿主在
别处对「注入不成立」是 fail-closed，在 here 是 fail-open。

## 判定依据（针对验收标准 1）

### 决策点

注入器自己把分支打了出来（同一个注入器进程，本会话 PID 20372）：

```
# PE32+ 产物（x64）与判别探针（ep0），共 6 次，每次都是这三行接一队列
[TSBX][INFO] Target is x64, direct injection
[TSBX][INFO] AddressOfEntryPoint=0; falling back to APC injection
[TSBX][INFO] LsInject_APC: APC queued successfully (will execute on ResumeThread)

# PE32 产物（AnyCPU），共 3 次，never 出现 APC 回退那一行
[TSBX][INFO] Target is x64, direct injection
[TSBX][INFO] Loader stub size: 144 bytes
```

两次都报 `Target is x64` —— 位数判断是**正确**的（`IsWow64Process2 processMachine=0x0000`）。
分叉只发生在 `AddressOfEntryPoint` 上。

### 判别探针（把「日志倒推」换成单变量行为证据）

拿 AnyCPU 产物，**只把 PE 头那 4 个字节里的 `AddressOfEntryPoint` 从 `0x37BE` 改成 0**，
其余字节一律不动（实际只有偏移 `0xa8/0xa9` 这 2 个字节发生变化，高位本来就是 0）：

| | 源码 | Machine | Magic | AddressOfEntryPoint | CorFlags | 行为 |
| --- | --- | --- | --- | --- | --- | --- |
| `probe-anycpu.exe` | 同一份 | `0x014c` | PE32 | `0x37be` | `ILONLY` | 约束**失效** |
| `probe-anycpu-ep0.exe` | 同一份 | `0x014c` | PE32 | **`0x0000`** | `ILONLY` | 约束**完全生效** |

两者除这 2 个字节外逐字节相同（`patch-entrypoint.json` 记录了 diff 偏移）。行为却从
「tsbx 零日志、删除语义原样」翻转为「tsbx 27 行日志、删除被改写」，且读数与 x64 产物
**逐项相同**。因此「判据 = `AddressOfEntryPoint`」不再是日志倒推，而是可复算的行为事实。

### 为什么定为缺陷（而不是「只支持 x64」的有意设计）

同一会话里，宿主对三种目标用了两套失败策略：

| 目标 | 宿主策略 | 结果 |
| --- | --- | --- |
| x86（WoW64） | **fail-closed**：`[TSBX][ERROR] Cross-arch injection failed, terminating process` | 进程被终止，调用方拿到 `SandboxError(0x00000006)` |
| AnyCPU（PE32+ILONLY，实跑 64 位） | **fail-open**：无任何错误，进程照常跑完 | 约束静默失效 |

同一个注入器，面对「32 位桥缺件」时选择终止进程，面对「direct injection 没生效」时选择放行。
后者既没有回读校验（没有「注入后确认目标已加载 tsbx.dll」这一步），也没有错误信号。
**这是实现里的缺口，不是策略上的取舍。**

## 读数（针对验收标准 2）

同一 Sandbox 会话、同一夹具目录、同一份源码、同一组参数（`kernel32 plain`），只变 `/platform`。
每组重复 3 次。

### 托管臂（`executionMode=sandbox`）

| 产物 | `/platform` | Machine | EntryPoint | CorFlags | 注入 | 探针 stdout | 该 PID 的 tsbx 日志行 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `probe-anycpu.exe` | 默认 | `0x014c` | `0x37be` | `ILONLY` | **0/3** | `tsbxLoaded=false` `error=145` `keepExists=true` | **0** |
| `probe-anycpu-ep0.exe` | 默认+改头 | `0x014c` | `0x0000` | `ILONLY` | **3/3** | `tsbxLoaded=true` `error=14007` `keepExists=false` | **27** |
| `probe-x64.exe` | x64 | `0x8664` | `0x0000` | `ILONLY` | **3/3** | `tsbxLoaded=true` `error=14007` `keepExists=false` | **27** |
| `probe-x86.exe` | x86 | `0x014c` | `0x37be` | `ILONLY\|32BITREQUIRED` | 启动失败 | `RunExecutable` 显式报错 | — |

- `error=14007` 与 `keepExists=false`/`removeReturned=true` 是 TF-0229 定位的 RECYCLE-BACKUP
  改写特征；`error=145`（`ERROR_DIR_NOT_EMPTY`）是未改写的正常语义。判据因此不是退出码。
- `probe-anycpu-ep0.exe` 启动后会因为 entry point 为 0 而崩（退出码 1），
  但**它的 tsbx 日志与 x64 一样是 27 行、含 `File hooks installed: 6/6` 与两条 RECYCLE-BACKUP**，
  说明崩溃发生在注入完成之后 —— 读数按 hints 取「文件副作用与日志」，不取退出码。

### 非托管臂（`executionMode=sandbox_bypass`）

四组全部 3/3：tsbx 日志 **0** 行、`tsbxLoaded=false`、`error=145`、`keepExists=true`。
包括 `probe-anycpu-ep0.exe` —— 说明翻转只在「被沙箱托管启动」这个前提下成立，
与 TF-0173/TF-0229 的触发条件一致。

### x86 组的显式失败原文

```
[TSBX] Cross-arch injection for child PID=45996 (child=0x014C, self=0x8664): <vendor>\x86\tsbx.dll
[TSBX-BRIDGE] Cross-arch injection bridge not available: <vendor>\x86\tsbx.dll not found
[TSBX] WARNING: Cross-arch injection failed for child PID=45996
[TSBX][INFO ] Target architecture: x86 [reason: processMachine=I386 (WoW64)]
[TSBX][INFO ] Target is x86 (WoW64), using rundll32 bridge
[TSBX][INFO ] Cross-arch injection: target PID=45996, DLL=...\runtime\x86\tsbx.dll
[TSBX-BRIDGE] Cross-arch injection bridge not available: ...\runtime\x86\tsbx.dll not found
[TSBX][ERROR] Cross-arch injection failed, terminating process
```

注入器在两个位置找 32 位的 tsbx：安装目录 `vendor\sandbox\5.5.5\x86\tsbx.dll` 与
会话 runtime 目录 `runtime\x86\tsbx.dll`，两处都不存在（该版本的 `vendor/sandbox/5.5.5/`
只带 64 位 `tsbx.dll`）。这是**安装缺件**，与 AnyCPU 的缺陷是两件事：
32 位目标会被明确拒绝，AnyCPU 会被静默放过。

## 影响面（针对验收标准 3）

- **命中的是最常见的产物形态。** AnyCPU 是 `csc` 不带 `/platform` 时的默认输出，也是
  Visual Studio 新建 .NET 项目的默认平台目标。也就是说：**任何默认构建的 .NET 程序
  被本宿主以沙箱模式托管启动时，tsbx 都不加载，沙箱约束完全不生效。**
- **失效是静默的。** 调用方拿到的是正常退出码和正常行为，没有任何信号表明约束没上。
  这与 x86 的「直接报错 + 终止进程」形成最坏组合：越常见的形态越安静。
- **受影响的约束面**：tsbx 承担的文件写保护（`default_action=deny_write`）、回收站备份
  （`recyclebin_backup`）、六个 ntdll 文件 API 的改写、DNS 域拦截 —— 这些对 AnyCPU 目标
  全部不生效。网络侧的 TCP 决策由 Rust LocalProxy 承担（见 `tsbx_rules.json` 的
  `_comment_network_policy`），那部分不依赖 tsbx 注入，是否仍生效**未在本轮测量**。
- **不受影响**：`sandbox_bypass` 臂本来就不注入；x64 产物（`/platform:x64`）工作正常；
  32 位目标会显式失败（fail-closed），不会静默。

## 修复方向（供宿主侧参考，不在本仓库范围）

1. **判据层面**：对带 CLR 头的托管程序集（`IMAGE_DIRECTORY_ENTRY_COM_DESCRIPTOR` 非空）
   一律走 APC 回退。`AddressOfEntryPoint` 对托管 PE 指向的是 `jmp _CorExeMain` 之类的
   启动 stub，不是可挂载的原生入口，用它当判据本身就不成立。
2. **兜底层面**：注入后回读目标模块列表确认 `tsbx.dll` 已加载；未加载则按 x86 那条路
   fail-closed（记 `[TSBX][ERROR]` 并终止），而不是放行。
3. 安装层面：随包分发 `x86\tsbx.dll`，否则 32 位目标永远走不到「约束生效」这一侧。

## 复算步骤

```bash
cd .agent-contexts/tf0231-20260921

# 1) 三平台产物（不覆盖 TF-0229 目录里的产物：那条证据链绑定了它们的 SHA256）
python build-platform-arm.py

# 2) PE 头读数（machine / magic / AddressOfEntryPoint / CorFlags）
python pe-flags.py

# 3) 判别探针：只改 AddressOfEntryPoint 这 4 字节，输出 diff 偏移
python patch-entrypoint.py

# 4) 同会话矩阵（四组 × 两臂 × 3 次）+ 同时抓 tsbx 日志；产出 run-platform-arm.log
python run-platform-arm.py

# 5) 产物指纹
cat artifact-sha256.txt
```

`probe-*.exe` 每次编译的 SHA256 都是确定的（同编译器、同源码），可与下表核对。

## 产物清单

| 文件 | 作用 | SHA256（前 16） |
| --- | --- | --- |
| `probe-anycpu.exe` | AnyCPU 对照产物 | `cd356083cbde398f` |
| `probe-x86.exe` | `/platform:x86` 产物 | `d06e59adbfadbec1` |
| `probe-x64.exe` | `/platform:x64` 产物 | `96107ec57e408f05` |
| `probe-anycpu-ep0.exe` | 判别探针（只改 entry point） | `dcfaedc287ced1c6` |
| `pe-flags.json` | 四产物的 PE/CLR 头读数 | `d3995575d4f283ce` |
| `patch-entrypoint.json` | 单变量改动记录（含 diff 偏移） | `5f856ba8e52a23e1` |
| `platform-K7UGvI/result.json` | 第一轮矩阵（三组） | `21b78008ac9269ca` |
| `platform-GLUJ5a/result.json` | 第二轮矩阵（四组，含判别探针） | `4566989feab425fc` |
| `dbgwin-platform.txt` | 第二轮 tsbx 日志原始捕获 | `6d3f2b3b3a2c7d55` |
| `run-platform-arm.log` | 读数对齐（行为 + 日志行数 + 全部决策行） | `0c837929ebde9337` |
| `branch-lines.txt` | 第一轮决策行节选 | `50927dc7781603e2` |
| `artifact-sha256.txt` | 全部产物指纹 | 见文件 |

## 未验证 / 存疑

1. **没有读注入器的实现。** 它是二进制（`sandbox_ffi.dll` / `tsbx_sdk.dll` / `sandbox-cli.exe`）。
   「判据是 `AddressOfEntryPoint`」由「只改这个字段行为就翻转」+ 日志分支原文共同支撑，
   属于**行为层面的确证**；若要落到代码行，需静态分析或符号，本轮没做。
2. **direct injection 为什么对托管程序集不生效**，只观察到「写了 `Loader stub size: 144 bytes`
   但主线程最终仍走到托管入口、tsbx 未加载」，没有进一步证明是「入口没被改写」还是
   「改写被 CLR 忽略」。
3. **网络约束的实际状态未测**：tsbx 不加载时 DNS hook 一定不生效；TCP 侧由 LocalProxy 承担，
   是否部分兜住，本轮没有实验。
4. `sandbox_bypass` 臂的 x64 三次只有一行 `[TSBX-CI] AddressOfEntryPoint=0; falling back to APC injection`，
   没有后续 `LsInject_APC` 行；该臂不做真注入这一点与 `tsbxLoaded=false` 一致，但日志为何仍打这一行未深究。
