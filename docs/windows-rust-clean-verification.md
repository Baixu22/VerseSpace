# Windows Rust 旁路撤销与 Git 故障复验

2026-09-14。针对 issue #6 第 8 项。活跃 Cargo registry 已恢复原始源；主项目全新和默认 target 均通过完整验证。
2026-09-15 补充：在重建的 WorkBuddy 宿主中已复现文件误删和 ref 消失，定位到非空目录删除语义被改变；
历史 Git 堆损坏的具体写入模块仍待证实。

## 原始依赖恢复

Cargo.lock 锁定 `boring-sys2` 4.15.15，归档 SHA256 为
`ab6c876a958d17057d9d3a31075bb9609237413a1fe665432782c31ef596eb6b`。
本机缓存归档校验一致。恢复前有 34 个归档文件被修改，另外存在两个手动补丁生成的 Kyber 文件；
`build/main.rs` 的 `ensure_patches_applied` 被注入 `PATCH-BYPASS-LOCAL` 并提前返回。

已从该归档完整恢复 registry 条目，951 个归档文件逐字节核对一致。
修改前的目录移入 `.agent-contexts/issue-6-closeout-2026-09-14/registry-backup/`，不留在活跃 registry 中。
未修改仓库的 Rust 依赖声明或 Cargo.lock，也未使用 `BORING_BSSL_ASSUME_PATCHED` 或预修补源码路径。

## 对照实验

| 程序 | 普通临时目录 | 仓库内隔离目录 |
| --- | --- | --- |
| 已安装 Git 2.51.0.windows.1 | 嵌套分支、remote ref、删除单文件均正常；BoringSSL 两个原始补丁成功 | 同左 |
| 已安装 Git 2.53.0.windows.3 | 嵌套分支、remote ref、删除单文件均正常 | 同左 |
| 官方 MinGit 2.55.0.windows.3 | 嵌套分支、remote ref、删除单文件均正常；BoringSSL 两个原始补丁成功 | 同左 |

MinGit 来自 `git-for-windows/git` 官方 `v2.55.0.windows.3` release，归档为 `MinGit-2.55.0.3-64-bit.zip`，
SHA256 `f48e2d2dc74a24454adc6d8fd0ac25bf9c2386f19cfb06202b9465aaad4f9f05` 与 release digest 一致。
仅解压运行在任务临时目录，没有安装或替换用户的 Git。

补丁实验复刻依赖的实际步骤：复制原始 BoringSSL → `git init` → 两次 `git apply -v --whitespace=fix`。
四组实验全部退出 0，两个 Kyber 产物均存在。额外的反向 `--check` 未通过，诊断另存；
它不属于依赖的构建流程，不能据此把已经成功的正向补丁步骤记作失败。

## 主项目验证

全新目标目录为 `%TEMP%/helmor-issue6-clean-target-20260914-183835`。
在 `src-tauri` 执行 `cargo test --locked -j 1 -- --test-threads=1`，关闭 rustc wrapper，使用恢复后的原始 registry。
全新 target：1,695 passed、0 failed、0 ignored。15 个测试目标/文档测试报告中，包含 1,527 个库测试与 168 个集成测试；原始两个补丁步骤在 build-script 输出中均可查。

随后在默认 `src-tauri/target` 执行 `cargo clean -p boring-sys2`，撤销与旁路相关的旧构建缓存，
再次执行同一完整测试命令：1,695 passed、0 failed、0 ignored；继而
`cargo clippy --locked -j 1 --all-targets -- -D warnings` 通过，零警告。
默认构建路径也已验证，不需要以后继续依赖临时 target 或旧旁路。
临时 target 已在后续清理中移除。上一轮递归删除命令被自动审批以“blocked by policy”拒绝；
用户要求继续处理后，先核对目录归属、进程占用与链接，再用 Cargo 的 `--dry-run` 预览范围，
最终以显式 `--target-dir` 的 `cargo clean --frozen` 删除 6,712 项构建产物，约 5.2 GiB。
临时目录已不存在；正常 target 的 BoringSSL 构建输出和 Cargo.lock 哈希均未改变，原始补丁日志与 registry 备份保留。

## 归因边界与复现入口

上述 2026-09-14 原生实验没有复现旧故障。2026-09-15 通过 WorkBuddy 文件操作模块运行同一 Git，
已重现文件损坏；宿主改变了 `RemoveDirectoryW` 对非空目录的行为。Git 2.55 的原生成功不能替代这一宿主对照。
后续如再发生堆损坏，应先保存 Git 可执行文件路径、版本、哈希、
Cargo build-script 输出、出错目录与文件操作进程证据，再判断原因；不能直接把防护排除项当作修复。

历史归因独立跟踪于 [issue #8](https://github.com/Baixu22/VerseSpace/issues/8)，不把当前验证通过写成已定位旧故障。
后续调查已恢复三次 Git 2.51 堆损坏的 Windows 事件，确认异常为 `0xC0000374`；原始转储和报告已缺失。
继续调查时复现了 123 同步空间与 NetSarang 外壳复制钩子相关的并发崩溃，已用当前用户级 COM 覆盖隔离；
512 次外壳删除及原始依赖的两个 Git 补丁通过，单项恢复后重新出现访问冲突。
该缓解不等于证实历史 Git 崩溃与其同因。证据、影响范围、还原入口和继续条件见
[崩溃调查记录](issue-8-crash-investigation.md)。
新版 SDK 5.6.1 的文件操作对照通过，但默认内容扫描会拦截 BoringSSL 的公开测试密钥；
完整补丁哈希对照是在独立测试 center 关闭该扫描后通过的，不能冒充默认配置的完整构建验证。
新版与现有 WorkBuddy 客户端的接口不兼容，尚未改动安装目录。可使用
[独立回归检查](../scripts/win/check-git-filesystem.ps1) 检查实际宿主是否仍会静默损坏文件。

本轮原始日志与检查器保存在 `.agent-contexts/issue-6-closeout-2026-09-14/`：

- `registry-before.json`、`registry-restored.json`：归档校验、修改清单、恢复位置。
- `git-environment-probe.json`：三个 Git 程序、两种目录、逐命令退出码。
- `boringssl-patch-probe.json`：四组原始补丁流程。
- `boringssl-reverse-check-diagnostic.json`：额外反向检查的失败诊断。
- `rust-clean-run.json`、`rust-clean.log`：主项目的全新构建目录与完整测试输出。
- `boringssl-clean-build-output.log`、`boringssl-clean-build-stderr.log`：清理前另存的原始补丁执行输出。
- `rust-clean-old-cache.log`、`rust-normal.log`、`clippy.log`：默认路径的缓存撤销、完整测试与 Clippy。
- `cache-clean-before.json`、`cache-clean-result.json`：后续缓存清理范围与清理后的核验结果。
