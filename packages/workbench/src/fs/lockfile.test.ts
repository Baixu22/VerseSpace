import { describe, expect, test } from "bun:test";
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquirePidLock } from "./lockfile";

function makeTempDir(): Promise<{ dir: string; cleanup(): Promise<void> }> {
	return (async () => {
		const dir = join(
			tmpdir(),
			`workbench-lockfile-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		await mkdir(dir, { recursive: true });
		return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
	})();
}

describe("acquirePidLock", () => {
	test("O_EXCL: concurrent acquirers cannot both win", async () => {
		const { dir, cleanup } = await makeTempDir();
		try {
			const lockPath = join(dir, "m.lock");
			const [a, b, c] = await Promise.all([
				acquirePidLock(lockPath),
				acquirePidLock(lockPath),
				acquirePidLock(lockPath),
			]);
			const winners = [a, b, c].filter((l) => l.acquired);
			expect(winners).toHaveLength(1);
			const losers = [a, b, c].filter((l) => !l.acquired);
			for (const loser of losers) {
				// holder is undefined when the loser raced into the pid-write
				// window; otherwise it is the winner's (this process's) pid
				if (loser.holder !== undefined) {
					expect(loser.holder).toBe(process.pid);
				}
			}
			await winners[0]?.release();
		} finally {
			await cleanup();
		}
	});

	test("release frees the lock; stale (dead pid) lock is taken over", async () => {
		const { dir, cleanup } = await makeTempDir();
		try {
			const lockPath = join(dir, "m.lock");
			const first = await acquirePidLock(lockPath);
			const second = await acquirePidLock(lockPath);
			expect(second.acquired).toBe(false);
			await first.release();
			const third = await acquirePidLock(lockPath);
			expect(third.acquired).toBe(true);
			await third.release();

			// a pid that cannot exist on any platform
			await writeFile(lockPath, JSON.stringify({ pid: 2_147_483_647 }));
			const takeover = await acquirePidLock(lockPath);
			expect(takeover.acquired).toBe(true);
			await takeover.release();
		} finally {
			await cleanup();
		}
	});

	test("fresh incomplete locks block; old unchanged remnants are reclaimed", async () => {
		const { dir, cleanup } = await makeTempDir();
		try {
			for (const [name, contents] of [
				["empty", ""],
				["malformed", "{"],
				["missing-pid", "{}"],
			] as const) {
				const lockPath = join(dir, `${name}.lock`);
				await writeFile(lockPath, contents);
				expect((await acquirePidLock(lockPath)).acquired).toBe(false);

				const old = new Date(Date.now() - 5000);
				await utimes(lockPath, old, old);
				const recovered = await acquirePidLock(lockPath);
				expect(recovered.acquired).toBe(true);
				await recovered.release();
			}
		} finally {
			await cleanup();
		}
	});
});
