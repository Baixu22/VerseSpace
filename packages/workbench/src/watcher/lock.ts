import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../fs/atomic";

export interface WatchLock {
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

/**
 * Single-instance mutex for `workbench watch`, implemented as a pid file in
 * the workbench root. A lock left behind by a crashed watcher (pid no longer
 * alive) is taken over automatically — all watcher state lives in the
 * blackboard files, so a fresh process simply converges on the next cycle.
 */
export async function acquireWatchLock(
	workbenchRoot: string,
): Promise<WatchLock> {
	const lockPath = join(workbenchRoot, "watch.lock");
	if (await exists(lockPath)) {
		try {
			const holder = JSON.parse(await readFile(lockPath, "utf8")) as {
				pid?: number;
			};
			if (typeof holder.pid === "number" && isProcessAlive(holder.pid)) {
				return { acquired: false, holder: holder.pid, release: async () => {} };
			}
		} catch {
			// unparseable lock file: treat as stale
		}
	}
	await writeFileAtomic(
		lockPath,
		JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
	);
	let released = false;
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

async function exists(path: string): Promise<boolean> {
	try {
		await readFile(path, "utf8");
		return true;
	} catch {
		return false;
	}
}
