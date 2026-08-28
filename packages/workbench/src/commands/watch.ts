import { isAbsolute, resolve } from "node:path";
import type { Command } from "commander";
import { emitJson, type GlobalOptions } from "../output";
import { startWatcher } from "../watcher";
import { acquireWatchLock } from "../watcher/lock";
import { resolveBlackboard } from "./context";

export async function watchCommand(command: Command): Promise<void> {
	const opts = command.optsWithGlobals() as GlobalOptions;
	const bb = await resolveBlackboard();

	const lock = await acquireWatchLock(bb.paths.root);
	if (!lock.acquired) {
		const message = `watch 已在运行（pid ${lock.holder}）`;
		if (opts.json) {
			emitJson({
				ok: false,
				error: "watch_already_running",
				holder: lock.holder,
			});
		} else {
			console.error(`workbench: ${message}`);
		}
		process.exitCode = 1;
		return;
	}

	// also watch registered contract files so drift is caught live
	const extraPaths = (await bb.interfaces.list()).map((entry) =>
		isAbsolute(entry.canonicalPath)
			? entry.canonicalPath
			: resolve(bb.projectRoot, entry.canonicalPath),
	);

	if (!opts.quiet) {
		console.log(
			`workbench: watching ${bb.paths.root}（pid ${process.pid}，Ctrl+C 退出）`,
		);
	}

	const handle = await startWatcher({
		workbenchRoot: bb.paths.root,
		extraPaths,
		onCycle: (result, durationMs) => {
			if (opts.quiet) {
				return;
			}
			const touched =
				result.applied +
				result.dispatches.length +
				result.reanchored.length +
				result.notifications.length;
			if (touched > 0) {
				console.log(
					`[watch] 转移 ${result.applied} · 派发 ${result.dispatches.length} · 重锚定 ${result.reanchored.length} · 通知 ${result.notifications.length}（${durationMs}ms）`,
				);
			}
		},
		onError: (error) => {
			console.error(
				`[watch] 循环出错：${error instanceof Error ? error.message : error}`,
			);
		},
	});

	const shutdown = async (signal: string): Promise<never> => {
		if (!opts.quiet) {
			console.log(`\nworkbench: 收到 ${signal}，正在退出…`);
		}
		await handle.stop();
		await lock.release();
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
