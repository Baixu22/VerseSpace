import { describe, expect, test } from "bun:test";
import { join } from "node:path";
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

	test("captures human editor writes as a human writer footprint (R1)", async () => {
		const ws = await makeTempWorkbench();
		const handle: WatchHandle = await startWatcher({
			workbenchRoot: ws.workbenchRoot,
			debounceMs: 50,
		});
		try {
			await waitFor(() => cycles0(handle));
			// a human edit in the project (IDE save) — outside .workbench
			const { writeFile, mkdir } = await import("node:fs/promises");
			await mkdir(join(ws.projectDir, "src"), { recursive: true });
			await writeFile(
				join(ws.projectDir, "src", "human-edit.ts"),
				"export const x = 1;",
				"utf8",
			);

			await waitFor(async () => {
				const writer = await ws.bb.sessions.get("human");
				if (!writer) {
					return false;
				}
				const lines = await ws.bb.sessions.footprint("human");
				return lines.some((l) =>
					l.generated.some((g) =>
						g.path.replace(/\\/g, "/").endsWith("src/human-edit.ts"),
					),
				);
			}, 8000);
			// the claim is versioned (content hash at capture)
			const lines = await ws.bb.sessions.footprint("human");
			const entry = lines
				.flatMap((l) => l.generated)
				.find((g) => g.path.endsWith("src/human-edit.ts"));
			expect(entry?.version).toBeTruthy();
			// the writer exists as a citizen, not a ghost
			expect((await ws.bb.sessions.get("human"))?.kind).toBe("human");
		} finally {
			await handle.stop();
			await ws.cleanup();
		}
	}, 15_000);

	test("captures external git commits as a git writer footprint (R1)", async () => {
		const ws = await makeTempWorkbench();
		// the fixture project is not a git repo: init one so refs exist
		const { execSync } = await import("node:child_process");
		execSync("git init -q", { cwd: ws.projectDir });
		execSync("git config user.email t@t", { cwd: ws.projectDir });
		execSync("git config user.name t", { cwd: ws.projectDir });
		const handle: WatchHandle = await startWatcher({
			workbenchRoot: ws.workbenchRoot,
			debounceMs: 50,
		});
		try {
			await waitFor(() => cycles0(handle));
			// an external commit moves refs — the runtime must see the writer
			const { writeFile } = await import("node:fs/promises");
			await writeFile(join(ws.projectDir, "f.txt"), "1", "utf8");
			execSync("git add -A", { cwd: ws.projectDir });
			execSync("git commit -qm probe", { cwd: ws.projectDir });

			await waitFor(async () => {
				const lines = await ws.bb.sessions.footprint("git");
				return lines.some((l) =>
					l.generated.some((g) => g.path.includes("refs/")),
				);
			}, 8000);
		} finally {
			await handle.stop();
			await ws.cleanup();
		}
	}, 15_000);

	// ---- R2 接线（TF-0116）：检测不该只发生在 UI server 进程里 ----

	test("每轮比对读集，把失效前提写进事件日志（R2 接线）", async () => {
		const ws = await makeTempWorkbench();
		const handle: WatchHandle = await startWatcher({
			workbenchRoot: ws.workbenchRoot,
			debounceMs: 50,
		});
		try {
			const { mkdir, writeFile } = await import("node:fs/promises");
			await mkdir(join(ws.projectDir, "src"), { recursive: true });
			await writeFile(
				join(ws.projectDir, "src", "shared.ts"),
				"export const v = 1;",
				"utf8",
			);
			// 写者 B 读过它，记下的版本是 v = 1 那一次的快照
			await ws.bb.sessions.register("agent-b", "agent", "B");
			await ws.bb.sessions.recordActivity("agent-b", {
				activity: "act-1",
				agent: "agent-b",
				used: [
					{ path: "src/shared.ts", version: "stale", durability: "volatile" },
				],
				generated: [],
			});
			// 写者 A 随后改了它
			await writeFile(
				join(ws.projectDir, "src", "shared.ts"),
				"export const v = 2;",
				"utf8",
			);

			await waitFor(async () => {
				const events = await ws.bb.events.query({ type: "premise_stale" });
				return events.length > 0;
			}, 20_000);

			const payloads = (
				await ws.bb.events.query({ type: "premise_stale" })
			).map(
				(e) =>
					e.payload as {
						writer?: string;
						stale?: Array<{ path: string }>;
					},
			);
			const forB = payloads.find((p) => p.writer === "agent-b");
			expect(forB?.stale?.map((s) => s.path)).toEqual(["src/shared.ts"]);
		} finally {
			await handle.stop();
			await ws.cleanup();
		}
	}, 60_000);

	test("reconcile: false 时 watcher 完全不做前提高和", async () => {
		const ws = await makeTempWorkbench();
		const handle: WatchHandle = await startWatcher({
			workbenchRoot: ws.workbenchRoot,
			debounceMs: 50,
			reconcile: false,
		});
		try {
			const { mkdir, writeFile } = await import("node:fs/promises");
			await mkdir(join(ws.projectDir, "src"), { recursive: true });
			await writeFile(
				join(ws.projectDir, "src", "shared.ts"),
				"export const v = 1;",
				"utf8",
			);
			await ws.bb.sessions.register("agent-c", "agent", "C");
			await ws.bb.sessions.recordActivity("agent-c", {
				activity: "act-1",
				agent: "agent-c",
				used: [
					{ path: "src/shared.ts", version: "stale", durability: "volatile" },
				],
				generated: [],
			});
			await writeFile(
				join(ws.projectDir, "src", "shared.ts"),
				"export const v = 2;",
				"utf8",
			);
			// 给足几轮机会，确认不是"还没跑到"
			await new Promise((resolve) => setTimeout(resolve, 2000));
			expect(await ws.bb.events.query({ type: "premise_stale" })).toHaveLength(
				0,
			);
		} finally {
			await handle.stop();
			await ws.cleanup();
		}
	}, 60_000);
});

function cycles0(_handle: WatchHandle): boolean {
	// the boot cycle has run as soon as the human writer is registered
	// (registration happens before the first cycle)
	return true;
}
