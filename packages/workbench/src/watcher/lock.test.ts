import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempWorkbench } from "../test/fixtures";
import { acquireWatchLock } from "./lock";

describe("acquireWatchLock", () => {
	test("is exclusive: second acquire fails, release frees it", async () => {
		const ws = await makeTempWorkbench();
		try {
			const first = await acquireWatchLock(ws.workbenchRoot);
			expect(first.acquired).toBe(true);

			const second = await acquireWatchLock(ws.workbenchRoot);
			expect(second.acquired).toBe(false);
			expect(second.holder).toBe(process.pid);

			await first.release();
			const third = await acquireWatchLock(ws.workbenchRoot);
			expect(third.acquired).toBe(true);
			await third.release();
		} finally {
			await ws.cleanup();
		}
	});

	test("takes over a stale lock left by a dead process", async () => {
		const ws = await makeTempWorkbench();
		try {
			// a pid that cannot exist on any platform
			const lockPath = join(ws.workbenchRoot, "watch.lock");
			await writeFile(lockPath, JSON.stringify({ pid: 2_147_483_647 }));
			const lock = await acquireWatchLock(ws.workbenchRoot);
			expect(lock.acquired).toBe(true);
			await lock.release();
		} finally {
			await ws.cleanup();
		}
	});

	test("live holder (this process) blocks acquisition", async () => {
		const ws = await makeTempWorkbench();
		try {
			const lockPath = join(ws.workbenchRoot, "watch.lock");
			await writeFile(lockPath, JSON.stringify({ pid: process.pid }));
			const lock = await acquireWatchLock(ws.workbenchRoot);
			expect(lock.acquired).toBe(false);
			expect(lock.holder).toBe(process.pid);
		} finally {
			await ws.cleanup();
		}
	});
});
