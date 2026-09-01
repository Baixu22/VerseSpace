import { mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface PidLock {
	acquired: boolean;
	/** pid of the process holding the lock, when acquisition failed. */
	holder?: number;
	release(): Promise<void>;
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but is owned by someone else —
		// still alive for our purposes
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

const staleLockMessage = "另一个进程持有锁（pid 已存活）或锁文件无法接管";

/**
 * Mutual exclusion via a pid lock file with O_EXCL creation semantics.
 *
 * The atomic step is `open(path, "wx")` — concurrent acquirers cannot both
 * win, no matter how the takeover path interleaves: a loser either sees the
 * winner's live pid or re-enters the loop after the takeover remove. A lock
 * left behind by a crashed holder (pid no longer alive) is taken over
 * automatically; all durable state lives in the blackboard files, so a fresh
 * process simply converges on its next cycle.
 */
export async function acquirePidLock(
	lockPath: string,
	/** Bounded takeover retries; the takeover window is tiny, 5 is generous. */
	maxAttempts = 5,
): Promise<PidLock> {
	for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			await mkdir(dirname(lockPath), { recursive: true });
			handle = await open(lockPath, "wx");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
				throw error;
			}
		}
		if (handle) {
			let released = false;
			await handle.writeFile(
				JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
				"utf8",
			);
			await handle.close();
			return {
				acquired: true,
				release: async () => {
					if (released) {
						return;
					}
					released = true;
					await rm(lockPath, { force: true });
				},
			};
		}
		// EEXIST: someone holds it. Read the pid: a live holder blocks, a dead
		// holder's file is removed so the next attempt can take over. An EMPTY
		// file means another acquirer just won the O_EXCL race and is between
		// create and write — it is alive; never remove its lock here (that
		// would resurrect the check-then-write race this lock exists to kill).
		try {
			const raw = await readFile(lockPath, "utf8");
			if (raw.trim() === "") {
				return { acquired: false, release: async () => {} };
			}
			const holder = JSON.parse(raw) as { pid?: number };
			if (typeof holder.pid === "number" && isProcessAlive(holder.pid)) {
				return { acquired: false, holder: holder.pid, release: async () => {} };
			}
		} catch {
			// unparseable non-empty lock file: treat as stale
		}
		await rm(lockPath, { force: true });
	}
	throw new Error(staleLockMessage);
}

/** Watcher singleton lock: one `workbench watch` per workbench root. */
export function acquireWatchLock(workbenchRoot: string): Promise<PidLock> {
	return acquirePidLock(join(workbenchRoot, "watch.lock"));
}

/** Runtime mutex: held for the duration of one `runOnce` cycle. */
export function acquireRunLock(workbenchRoot: string): Promise<PidLock> {
	return acquirePidLock(join(workbenchRoot, "run.lock"));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn` while holding a per-object pid lock — the mutual exclusion half of
 * the blackboard's CAS writes. Contention (another process holds it) waits
 * briefly and then fails loudly instead of racing.
 */
export async function withPidLock<T>(
	lockPath: string,
	fn: () => Promise<T>,
	waitMs = 2000,
): Promise<T> {
	const deadline = Date.now() + waitMs;
	for (;;) {
		const lock = await acquirePidLock(lockPath);
		if (lock.acquired) {
			try {
				return await fn();
			} finally {
				await lock.release();
			}
		}
		if (Date.now() >= deadline) {
			throw new Error(
				`锁被长期占用（pid ${lock.holder ?? "未知"}）：${lockPath}`,
			);
		}
		await sleep(10);
	}
}
