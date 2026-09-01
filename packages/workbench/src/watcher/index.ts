import { join } from "node:path";
import chokidar from "chokidar";
import { openBlackboard } from "../blackboard";
import { hashPathClaim } from "../blackboard/footprint";
import { workbenchPaths } from "../paths";
import { type RunOnceResult, runOnce } from "../runtime";
import {
	reconcilePremises,
	type StalePremiseNotice,
} from "../runtime/premises";

export interface WatchOptions {
	workbenchRoot: string;
	/** Extra project paths to watch (e.g. registered contract files). */
	extraPaths?: string[];
	/** Coalesce bursts of writes into one cycle. Default 500ms. */
	debounceMs?: number;
	onCycle?: (result: RunOnceResult, durationMs: number) => void;
	onError?: (error: unknown) => void;
	/**
	 * R2：每一轮之后比对各写者的读集与磁盘现值。默认开启；传 false 关掉。
	 * 检测是建议式的，失败不影响本轮的自动化推进。
	 */
	reconcile?: boolean;
	/**
	 * R2：把前提失效通知投递进活会话。检测与投递在这里分离——watcher 只
	 * 负责检测，只有真正持有会话的宿主（UI server）才传这个回调；不传时
	 * 通知只落进事件日志排队，等写者下一次运行再排空。
	 */
	deliverNotice?: (
		notice: StalePremiseNotice,
	) => Promise<"delivered" | "queued">;
}

export interface WatchHandle {
	stop(): Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The Watcher (skeleton module 6): observe the project and the blackboard
 * directories, run one Runtime cycle per debounced burst of changes, and
 * (R1) capture the writers the runtime would otherwise not see: the human's
 * editor and external git movement. Converging by design — a cycle that
 * applies transitions may write files (which re-trigger), but a consistent
 * world produces zero writes, so the loop always settles.
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
	const projectRoot = normalize(bb.projectRoot);
	const gitDir = `${projectRoot}/.git`;
	const gitRefs = `${gitDir}/refs`;
	const gitHead = `${gitDir}/HEAD`;
	const blackboardDir = normalize(paths.blackboard);
	// capture targets: project files not owned by the runtime or the tooling
	const isGitWatched = (p: string): boolean =>
		p === gitHead || p.startsWith(gitRefs);
	const isProjectFile = (p: string): boolean =>
		p.startsWith(`${projectRoot}/`) &&
		!p.startsWith(`${blackboardDir}/`) &&
		!p.includes("/node_modules/") &&
		!p.includes("/worktrees/") &&
		!p.startsWith(gitDir);

	// R1 writer capture: batch project edits and ref movements per cycle,
	// attributing to agents what an agent's own footprint already claimed
	const humanPending = new Set<string>();
	const gitPending = new Set<string>();
	await bb.sessions.register("human", "human", "编辑器（watcher 捕获）");
	await bb.sessions.register("git", "git", "git 变动（watcher 捕获）");

	const flushPending = async (): Promise<void> => {
		const human = [...humanPending];
		humanPending.clear();
		const refs = [...gitPending];
		gitPending.clear();
		if (human.length > 0) {
			const claimed = await bb.sessions.recentGeneratedPaths(10_000);
			const generated = [];
			for (const path of human) {
				if (claimed.has(path)) {
					continue; // an agent session already claimed this write
				}
				generated.push(await hashPathClaim(bb.projectRoot, path));
			}
			if (generated.length > 0) {
				await bb.sessions.recordActivity("human", {
					activity: `watch-${Date.now()}`,
					agent: "human",
					used: [],
					generated,
					facets: { via: "watcher" },
				});
			}
		}
		if (refs.length > 0) {
			await bb.sessions.recordActivity("git", {
				activity: `git-${Date.now()}`,
				agent: "git",
				used: [],
				generated: refs.map((path) => ({ path, version: null })),
				facets: { via: "watcher", kind: "ref-update" },
			});
		}
	};

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
			await flushPending();
			const result = await runOnce(bb);
			if (result.busy) {
				// another runOnce holds the run lock (manual sync / UI trigger):
				// skip this tick — the watcher converges on the next change
				return;
			}
			options.onCycle?.(result, Date.now() - startedAt);
			// R2 premise reconciliation: advisory detection runs wherever the
			// world is being watched. It only writes into events/, which the
			// watcher ignores, so a persistent stale premise cannot re-trigger
			// the loop — the (writer, path, currentVersion) dedup keeps each
			// one to a single notice.
			if (options.reconcile !== false) {
				await reconcilePremises(
					bb,
					options.deliverNotice
						? { deliver: options.deliverNotice }
						: undefined,
				);
			}
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

	const watcher = chokidar.watch(
		[projectRoot, gitHead, gitRefs, ...(options.extraPaths ?? [])],
		{
			ignoreInitial: true,
			ignored: (path: string) => {
				const p = normalize(path);
				return (
					path === normalize(eventsDir) ||
					p.startsWith(normalize(eventsDir)) ||
					p === normalize(join(paths.root, "watch.lock")) ||
					p === normalize(join(paths.root, "run.lock")) ||
					/\.tmp$/.test(p) ||
					p.includes("/node_modules/") ||
					p.includes("/worktrees/") ||
					// .git internals are noise EXCEPT refs and HEAD (git writer)
					(p.startsWith(`${gitDir}/`) && !isGitWatched(p))
				);
			},
			awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 20 },
		},
	);
	watcher.on("all", (_event, path) => {
		const p = normalize(path);
		if (isGitWatched(p)) {
			gitPending.add(p);
		} else if (isProjectFile(p)) {
			humanPending.add(p);
		}
		schedule();
	});

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
