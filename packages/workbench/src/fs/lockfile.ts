import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
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

async function lockPathExists(lockPath: string): Promise<boolean> {
	try {
		await stat(lockPath);
		return true;
	} catch {
		return false;
	}
}

const staleLockMessage = "另一个进程持有锁（pid 已存活）或锁文件无法接管";
const INCOMPLETE_LOCK_GRACE_MS = 1000;

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
	/** Bounded retries for stale takeover and transient sharing violations. */
	maxAttempts = 5,
): Promise<PidLock> {
	for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			await mkdir(dirname(lockPath), { recursive: true });
			handle = await open(lockPath, "wx");
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			// A Windows sharing violation can outlive the lock's removal. Retry
			// the exclusive open briefly; persistent permission failures still throw.
			if (code === "EPERM" || code === "EACCES") {
				if (!(await lockPathExists(lockPath))) {
					if (attempt === maxAttempts - 1) throw error;
					await sleep(10);
					continue;
				}
			} else if (code !== "EEXIST") {
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
		let stale = false;
		let observedRaw = "";
		let observedMtimeMs = 0;
		try {
			observedMtimeMs = (await stat(lockPath)).mtimeMs;
			const raw = await readFile(lockPath, "utf8");
			observedRaw = raw;
			if (raw.trim() === "") {
				if (Date.now() - observedMtimeMs < INCOMPLETE_LOCK_GRACE_MS) {
					return { acquired: false, release: async () => {} };
				}
				stale = true;
			} else {
				const holder = JSON.parse(raw) as { pid?: number };
				if (typeof holder.pid !== "number") {
					if (Date.now() - observedMtimeMs < INCOMPLETE_LOCK_GRACE_MS) {
						return { acquired: false, release: async () => {} };
					}
					stale = true;
				} else if (isProcessAlive(holder.pid)) {
					return {
						acquired: false,
						holder: holder.pid,
						release: async () => {},
					};
				} else {
					stale = true;
				}
			}
		} catch {
			// A partially-written lock is likely a live contender. Give it a
			// moment to finish; an old unchanged remnant can be reclaimed.
			if (
				observedMtimeMs === 0 ||
				Date.now() - observedMtimeMs < INCOMPLETE_LOCK_GRACE_MS
			) {
				return { acquired: false, release: async () => {} };
			}
			stale = true;
		}
		if (!stale) {
			continue;
		}
		// Re-read before takeover so a new owner cannot be deleted merely because
		// the old pid was observed in an earlier read.
		try {
			const current = await stat(lockPath);
			if (
				current.mtimeMs !== observedMtimeMs ||
				(await readFile(lockPath, "utf8")) !== observedRaw
			) {
				continue;
			}
			await rm(lockPath, { force: true });
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			// Windows may report a transient EFAULT/ sharing violation when another
			// contender removed or replaced the file. Treat it as contention and let
			// the caller retry under withPidLock rather than failing the append.
			if (
				code === "ENOENT" ||
				code === "EFAULT" ||
				code === "EPERM" ||
				code === "EACCES"
			) {
				return { acquired: false, release: async () => {} };
			}
			throw error;
		}
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
