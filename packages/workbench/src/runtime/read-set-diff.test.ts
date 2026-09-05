import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hashPathClaim } from "../blackboard/footprint";
import { ChatThreads, type StoredMessage } from "../chat/threads";
import { makeTempWorkbench } from "../test/fixtures";
import { diffReadSet } from "./read-set-diff";

async function appendUserMessage(
	root: string,
	threadId: string,
	message: StoredMessage,
): Promise<void> {
	await writeFile(
		join(root, "threads", threadId, "messages.jsonl"),
		`${JSON.stringify(message)}\n`,
		"utf8",
	);
}

describe("restore-time read-set diff", () => {
	test("compares the leave baseline and attributes later writes as estimates", async () => {
		const ws = await makeTempWorkbench();
		try {
			await mkdir(join(ws.projectDir, "src"), { recursive: true });
			const path = join(ws.projectDir, "src", "a.ts");
			await writeFile(path, "export const value = 1;\n", "utf8");
			const chat = new ChatThreads(ws.bb);
			const thread = await chat.create();
			await appendUserMessage(`${ws.projectDir}/.workbench`, thread.id, {
				id: "m-1",
				role: "user",
				text: "读取 a.ts",
				at: "2026-08-28T00:00:00.000Z",
			});
			await ws.bb.sessions.recordActivity(thread.id, {
				activity: "read-a",
				agent: thread.id,
				used: [
					await hashPathClaim(
						ws.projectDir,
						"src/a.ts",
						join(ws.workbenchRoot, "sessions", thread.id, "spool"),
					),
				],
				generated: [],
			});
			const note = await chat.leave(
				thread.id,
				new Date("2026-08-28T01:00:00.000Z"),
			);
			expect(note?.leaveSignature.footprintSeq).toBe(1);

			await writeFile(path, "export const value = 2;\n", "utf8");
			await ws.bb.sessions.register("human", "human", "编辑器");
			await ws.bb.sessions.recordActivity("human", {
				activity: "edit-a",
				agent: "human",
				used: [],
				generated: [await hashPathClaim(ws.projectDir, "src/a.ts")],
			});

			const result = await diffReadSet(ws.bb, thread.id, note?.leaveSignature);
			expect(result.status).toBe("available");
			expect(result.baseline?.footprintSeq).toBe(1);
			expect(result.compared).toBe(1);
			expect(result.comparable).toBe(1);
			expect(result.stale).toHaveLength(1);
			expect(result.stale[0]?.path).toBe("src/a.ts");
			expect(result.stale[0]?.observedVersion).not.toBe(
				result.stale[0]?.currentVersion,
			);
			expect(result.stale[0]?.writerId).toBe("human");
			expect(result.stale[0]?.writerKind).toBe("human");
			expect(result.stale[0]?.diff).toContain("value = 2");
			expect(result.stale[0]?.refs.length).toBeGreaterThanOrEqual(2);
		} finally {
			await ws.cleanup();
		}
	});

	test("returns version facts without a diff when the spool was removed", async () => {
		const ws = await makeTempWorkbench();
		try {
			await mkdir(join(ws.projectDir, "src"), { recursive: true });
			const path = join(ws.projectDir, "src", "a.ts");
			await writeFile(path, "export const a = 1;\n", "utf8");
			const chat = new ChatThreads(ws.bb);
			const thread = await chat.create();
			const claim = await hashPathClaim(
				ws.projectDir,
				"src/a.ts",
				join(ws.workbenchRoot, "sessions", thread.id, "spool"),
			);
			await ws.bb.sessions.recordActivity(thread.id, {
				activity: "read-a",
				agent: thread.id,
				used: [claim],
				generated: [],
			});
			const note = await chat.leave(thread.id);
			if (claim.spool) {
				await rm(
					join(ws.workbenchRoot, "sessions", thread.id, "spool", claim.spool),
					{
						force: true,
					},
				);
			}
			await writeFile(path, "export const a = 2;\n", "utf8");
			const result = await diffReadSet(ws.bb, thread.id, note?.leaveSignature);
			expect(result.stale).toHaveLength(1);
			expect(result.stale[0]?.currentVersion).toBeTruthy();
			expect(result.stale[0]?.diff).toBeUndefined();
		} finally {
			await ws.cleanup();
		}
	});

	// TF-0129: a Grep over `src/` used to count as one "read" that could never
	// be compared, which made the coverage number describe searches instead of
	// file reads. Directory claims are now out of the accounting entirely.
	test("目录 claim（Grep/Glob）整个剔出覆盖率，不虚高也不虚低", async () => {
		const ws = await makeTempWorkbench();
		try {
			await mkdir(join(ws.projectDir, "src"), { recursive: true });
			await writeFile(join(ws.projectDir, "src", "a.ts"), "a", "utf8");
			await writeFile(join(ws.projectDir, "src", "b.ts"), "b", "utf8");
			const chat = new ChatThreads(ws.bb);
			const thread = await chat.create();
			await ws.bb.sessions.recordActivity(thread.id, {
				activity: "grep-a",
				agent: thread.id,
				used: [{ path: "src", version: null }],
				generated: [],
				facets: { tool: "Grep" },
			});
			const note = await chat.leave(thread.id);
			await ws.bb.sessions.recordActivity(thread.id, {
				activity: "read-b-after-leave",
				agent: thread.id,
				used: [{ path: "src/b.ts", version: "not-in-baseline" }],
				generated: [],
				facets: { tool: "Read" },
			});
			await writeFile(join(ws.projectDir, "src", "b.ts"), "changed", "utf8");
			const result = await diffReadSet(ws.bb, thread.id, note?.leaveSignature);
			expect(result.status).toBe("available");
			expect(result.excludedDirectories).toBe(1);
			expect(result.compared).toBe(0);
			expect(result.comparable).toBe(0);
			expect(result.unsupported).toBe(0);
			// Grep 只声明了那个目录，它不是一次「未覆盖的文件读」
			expect(result.uncoveredTools).toEqual([]);
			expect(result.stale).toHaveLength(0);
		} finally {
			await ws.cleanup();
		}
	});

	test("文件上的 null 版本仍算 unsupported，并列出该工具", async () => {
		const ws = await makeTempWorkbench();
		try {
			await mkdir(join(ws.projectDir, "src"), { recursive: true });
			await writeFile(join(ws.projectDir, "src", "a.ts"), "a", "utf8");
			const chat = new ChatThreads(ws.bb);
			const thread = await chat.create();
			await ws.bb.sessions.recordActivity(thread.id, {
				activity: "read-unhashed",
				agent: thread.id,
				// 一个真实文件，但读的时候没算出版本（过大 / 当时缺失）
				used: [{ path: "src/a.ts", version: null }],
				generated: [],
				facets: { tool: "Read" },
			});
			const note = await chat.leave(thread.id);
			const result = await diffReadSet(ws.bb, thread.id, note?.leaveSignature);
			expect(result.excludedDirectories).toBe(0);
			expect(result.compared).toBe(1);
			expect(result.comparable).toBe(0);
			expect(result.unsupported).toBe(1);
			expect(result.uncoveredTools).toEqual(["Read"]);
		} finally {
			await ws.cleanup();
		}
	});

	test("does not borrow a newer leave for a legacy note without a baseline", async () => {
		const ws = await makeTempWorkbench();
		try {
			const chat = new ChatThreads(ws.bb);
			const thread = await chat.create();
			await appendUserMessage(`${ws.projectDir}/.workbench`, thread.id, {
				id: "m-1",
				role: "user",
				text: "旧笔记",
				at: new Date().toISOString(),
			});
			await chat.leave(thread.id);
			const result = await diffReadSet(ws.bb, thread.id, {
				lastMessageAt: new Date().toISOString(),
				messageCount: 1,
			});
			expect(result.status).toBe("unknown");
			expect(result.baseline).toBeNull();
		} finally {
			await ws.cleanup();
		}
	});
});
