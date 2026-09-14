# Windows Rust 旁路撤销与 Git 故障复验

2026-09-14。针对 issue #6 第 8 项。活跃 Cargo registry 已恢复原始源；主项目全新和默认 target 均通过完整验证。
历史故障当前未复现，不能将它归因于防护、宿主钩子或 Git 版本。

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

## 归因边界与复现入口

当前实验没有复现旧故障。已知事实是原始依赖可在当前环境执行其补丁；没有证据确定旧失败由哪个进程造成。
Git 2.55 的当前成功也不能解释原先为何失败。后续如再发生，应先保存 Git 可执行文件路径、版本、哈希、
Cargo build-script 输出、出错目录与文件操作进程证据，再判断原因；不能直接把防护排除项当作修复。

历史归因独立跟踪于 [issue #8](https://github.com/Baixu22/VerseSpace/issues/8)，不把当前验证通过写成已定位旧故障。

本轮原始日志与检查器保存在 `.agent-contexts/issue-6-closeout-2026-09-14/`：

- `registry-before.json`、`registry-restored.json`：归档校验、修改清单、恢复位置。
- `git-environment-probe.json`：三个 Git 程序、两种目录、逐命令退出码。
- `boringssl-patch-probe.json`：四组原始补丁流程。
- `boringssl-reverse-check-diagnostic.json`：额外反向检查的失败诊断。
- `rust-clean-run.json`、`rust-clean.log`：主项目的全新构建目录与完整测试输出。
- `rust-clean-old-cache.log`、`rust-normal.log`、`clippy.log`：默认路径的缓存撤销、完整测试与 Clippy。
