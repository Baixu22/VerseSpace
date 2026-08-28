# ADR-0001：运行时 = Bun 1.3 + TypeScript

- 状态：已接受
- 日期：2026-08-28

## 背景

Workbench 是 CLI + 文件系统状态管理器（《Workbench 实现架构骨架》），需要：单文件可执行分发、大量文件 IO、受控子进程执行验证命令、跨平台（Windows/macOS/Linux）。仓库已有 sidecar（Bun + TypeScript）的成熟实践。

## 决策

采用 Bun 1.3 + TypeScript 作为 Workbench 的运行时与语言；骨架文档第六节的类型定义（types/*.ts）即跨模块契约，先定义类型、再各自实现模块。

## 理由

- sidecar 已验证整条链路：独立 lockfile、tsconfig、bun test、`bun build --compile` 三平台单文件编译，零额外引入成本。
- 骨架文档的类型契约以 TypeScript 表达，需要类型系统支撑「类型先行」的开发方式。
- 状态机（各 4-6 个状态）按骨架要求手写 switch/case，不引入 xstate 等状态机库。

## 备选

- Rust（复用 src-tauri 的 git 能力）：与 helmor-cli 同栈，但类型契约表达、迭代速度与分发便利性不如 Bun；git 操作直接 shell 调用 `git` CLI 即可，无需复用 Rust 代码。
- Node.js + tsx/tsup：可行，但单文件分发需要额外打包步骤，`bun build --compile` 更省事。

## 后果

- 正面：与仓库现有工具链（biome、bun test、bun compile）完全一致。
- 负面：绑定 Bun 运行时，上游 API 变动需跟随升级。
