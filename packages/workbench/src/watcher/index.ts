import { join } from "node:path";
import chokidar from "chokidar";
import { openBlackboard } from "../blackboard";
import { workbenchPaths } from "../paths";
import { type RunOnceResult, runOnce } from "../runtime";

export interface WatchOptions {
	workbenchRoot: string;
	/** Extra project paths to watch (e.g. registered contract files). */
	extraPaths?: string[];
	/** Coalesce bursts of writes into one cycle. Default 500ms. */
	debounceMs?: number;
	onCycle?: (result: RunOnceResult, durationMs: number) => void;
	onError?: (error: unknown) => void;
}

export interface WatchHandle {
	stop(): Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The Watcher (skeleton module 6): observe the blackboard directories and run
 * one Runtime cycle per debounced burst of changes. Converging by design — a
 * cycle that applies transitions may write files (which re-trigger), but a
 * consistent world produces zero writes, so the loop always settles. The
 * events log and atomic-write temp files are excluded from watching to break
 * the self-trigger loop.
 */
export async function startWatcher(
	options: WatchOptions,
): Promise<WatchHandle> {
	const debounceMs = options.debounceMs ?? 500;
	const bb = openBlackboard(options.workbenchRoot);
	const paths = workbenchPaths(options.workbenchRoot);
	// chokidar reports paths with forward slashes on every platform
	const eventsDir = paths.eventsDir;
	const normalize = (p: string): string => p.replace(/\\/g, "/");

	let running = false;
	let pending = false;
	let stopped = false;

	const cycle = async (): Promise<void> => {
		if (stopped) {
			return;
		}
		if (running) {
			pending = true;
			return;
		}
		running = true;
		const startedAt = Date.now();
		try {
			const result = await runOnce(bb);
			options.onCycle?.(result, Date.now() - startedAt);
		} catch (error) {
			options.onError?.(error);
		} finally {
			running = false;
			if (pending && !stopped) {
				pending = false;
				await cycle();
			}
		}
	};

	let timer: ReturnType<typeof setTimeout> | null = null;
	const schedule = (): void => {
		if (stopped) {
			return;
		}
		if (timer !== null) {
			clearTimeout(timer);
		}
		timer = setTimeout(() => {
			timer = null;
			void cycle();
		}, debounceMs);
	};

	const watcher = chokidar.watch([paths.root, ...(options.extraPaths ?? [])], {
		ignoreInitial: true,
		ignored: (path: string) =>
			path.startsWith(normalize(eventsDir)) ||
			path === normalize(join(paths.root, "watch.lock")) ||
			/\.tmp$/.test(path),
		awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 20 },
	});
	watcher.on("all", schedule);

	// chokidar's initial scan is async: wait until every directory watch is
	// armed, otherwise writes landing in the first milliseconds are missed
	await new Promise<void>((resolve) => {
		watcher.once("ready", () => resolve());
	});

	// converge once at boot: crash recovery is free because all state lives in
	// the blackboard files — the first cycle picks up whatever was pending
	await cycle();

	return {
		async stop() {
			stopped = true;
			if (timer !== null) {
				clearTimeout(timer);
			}
			await watcher.close();
			const deadline = Date.now() + 2000;
			while (running && Date.now() < deadline) {
				await sleep(10);
			}
		},
	};
}
