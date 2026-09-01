import { setDefaultTimeout } from "bun:test";

/**
 * bun 的测试超时上限只能通过 `--timeout` 或这个 API 设置，bunfig.toml 的
 * `[test]` 段不认识 `timeout` 键。
 *
 * 本机（Windows / D 盘）实测文件删除约 350–500ms/条目：临时目录里 100 个
 * 条目的 `rm -rf` 要 35–49 秒（bun 与 node 一致，关掉宿主沙箱也一样，属
 * 机器本身的 FS 开销）。`makeTempWorkbench()` 的清理因此会轻易突破默认的
 * 5000ms，把本来能过的用例判死。
 *
 * 只抬高上限、不设下限：CI 跑在 Linux/macOS 上不受影响，正常的快用例也
 * 不会因为这里变慢。
 */
setDefaultTimeout(60_000);
