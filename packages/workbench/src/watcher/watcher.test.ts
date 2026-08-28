import { describe, expect, test } from "bun:test";
import { makeTempWorkbench } from "../test/fixtures";
import { startWatcher, type WatchHandle } from "./index";

async function waitFor(
	predicate: () => boolean | Promise<boolean>,
	timeoutMs = 5000,
	stepMs = 50,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, stepMs));
	}
	throw new Error("waitFor timed out");
}

describe("startWatcher", () => {
	test("converges on boot, reacts to goal writes, and settles", async () => {
		const ws = await makeTempWorkbench();
		let cycles = 0;
		const handle: WatchHandle = await startWatcher({
			workbenchRoot: ws.workbenchRoot,
			debounceMs: 50,
			onCycle: () => {
				cycles += 1;
			},
		});
		try {
			// boot cycle runs immediately (crash recovery hook)
			await waitFor(() => cycles >= 1);

			// writing a goal triggers debounced cycles until the world settles:
			// planned → ready → enqueued
			const goal = await ws.bb.goals.add({ title: "监听测试" });
			await waitFor(async () =>
				(await ws.bb.state.queue.get()).includes(goal.id),
			);

			// the loop must settle — events.jsonl and tmp files are ignored, so
			// a consistent world produces no writes and no further cycles.
			// First let the trailing drain-cycles finish, then require two
			// consecutive quiet windows with an unchanged cycle count.
			await new Promise((resolve) => setTimeout(resolve, 1200));
			const quietMark = cycles;
			await new Promise((resolve) => setTimeout(resolve, 800));
			expect(cycles).toBe(quietMark);
		} finally {
			await handle.stop();
			await ws.cleanup();
		}
	}, 15_000);

	test("stop() halts the loop", async () => {
		const ws = await makeTempWorkbench();
		let cycles = 0;
		const handle = await startWatcher({
			workbenchRoot: ws.workbenchRoot,
			debounceMs: 50,
			onCycle: () => {
				cycles += 1;
			},
		});
		try {
			await waitFor(() => cycles >= 1);
			await handle.stop();

			await ws.bb.goals.add({ title: "停机后写入" });
			await new Promise((resolve) => setTimeout(resolve, 500));
			expect(cycles).toBeLessThan(3);
		} finally {
			await ws.cleanup();
		}
	}, 15_000);
});
