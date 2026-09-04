import { describe, expect, test } from "bun:test";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempWorkbench } from "../test/fixtures";
import { collectChatStats } from "./stats";
import { ChatThreads, type StoredMessage } from "./threads";

function message(role: "user" | "assistant", text: string): StoredMessage {
	return {
		id: `m-${Math.random().toString(36).slice(2, 8)}`,
		role,
		text,
		at: new Date().toISOString(),
	};
}

async function appendMessages(
	workbenchRoot: string,
	threadId: string,
	messages: StoredMessage[],
): Promise<void> {
	await appendFile(
		join(workbenchRoot, "threads", threadId, "messages.jsonl"),
		`${messages.map((item) => JSON.stringify(item)).join("\n")}\n`,
		"utf8",
	);
}

describe("collectChatStats", () => {
	test("returns insufficient history for an empty workbench", async () => {
		const { bb, cleanup } = await makeTempWorkbench();
		try {
			const stats = await collectChatStats(bb);
			expect(stats.threads.total).toBe(0);
			expect(stats.forks.total).toBe(0);
			expect(stats.observation.startedAt).toBeNull();
			expect(stats.dataQuality.insufficientHistory).toBe(true);
			expect(stats.dataQuality.reasons).toContain("no threads");
		} finally {
			await cleanup();
		}
	});

	test("counts fork lineage, resume notes, and footprints without writing new state", async () => {
		const { workbenchRoot, bb, cleanup } = await makeTempWorkbench();
		try {
			const chat = new ChatThreads(bb);
			const thread = await chat.create();
			const user = message("user", "调研前提守护");
			const assistant = message("assistant", "先做恢复卡");
			await appendMessages(workbenchRoot, thread.id, [user, assistant]);
			await chat.leave(thread.id);
			await bb.sessions.recordActivity(thread.id, {
				activity: "stats-test",
				agent: thread.id,
				used: [{ path: "src/a.ts", version: "v1" }],
				generated: [],
			});
			const fork = await chat.fork(thread.id, user.id);
			expect(fork.ok).toBe(true);

			const stats = await collectChatStats(bb);
			expect(stats.threads.total).toBe(2);
			expect(stats.threads.forked).toBe(1);
			expect(stats.threads.withMessages).toBe(2);
			expect(stats.threads.withResumeNotes).toBe(1);
			expect(stats.threads.withFootprints).toBe(1);
			expect(stats.forks.total).toBe(1);
			expect(stats.forks.perWeek).toBeNull();
			expect(stats.forks.depth.min).toBe(1);
			expect(stats.forks.depth.max).toBe(1);
			expect(stats.forks.families.count).toBe(1);
			expect(stats.forks.families.largestSize).toBe(2);
			expect(stats.siblingAlternation.available).toBe(false);
			expect(stats.dataQuality.insufficientHistory).toBe(true);
			expect(stats.dataQuality.reasons).toContain(
				"observation window is shorter than 7 days",
			);
		} finally {
			await cleanup();
		}
	});

	test("folds lifecycle observations and counts forkOf, not reload counters", async () => {
		const { workbenchRoot, bb, cleanup } = await makeTempWorkbench();
		try {
			const chat = new ChatThreads(bb);
			const root = await chat.create();
			const user = message("user", "分叉锚点");
			await appendMessages(workbenchRoot, root.id, [user]);
			const first = await chat.fork(root.id, user.id);
			const second = await chat.fork(root.id, user.id);
			expect(first.ok && second.ok).toBe(true);
			const firstId = first.thread!.id;
			const secondId = second.thread!.id;

			// Simulate reload noise on the source: stats must not mistake this for
			// another child fork.
			const rootMetaFile = join(workbenchRoot, "threads", root.id, "meta.json");
			const rootMeta = JSON.parse(await readFile(rootMetaFile, "utf8")) as {
				forks?: Record<string, number>;
			};
			rootMeta.forks = { [user.id]: 99 };
			await writeFile(rootMetaFile, JSON.stringify(rootMeta), "utf8");

			const now = Date.now();
			const iso = (offset: number) => new Date(now + offset).toISOString();
			await bb.events.append({
				timestamp: iso(0),
				source: "threads",
				type: "thread.switch",
				payload: {
					threadId: firstId,
					fromThreadId: secondId,
					toThreadId: firstId,
				},
			});
			await bb.events.append({
				timestamp: iso(1_000),
				source: "threads",
				type: "thread.switch",
				payload: {
					threadId: secondId,
					fromThreadId: firstId,
					toThreadId: secondId,
				},
			});
			await bb.events.append({
				timestamp: iso(2_000),
				source: "threads",
				type: "thread.switch",
				payload: {
					threadId: firstId,
					fromThreadId: secondId,
					toThreadId: firstId,
				},
			});
			await bb.events.appendThread("thread.restored", {
				threadId: firstId,
				fromThreadId: root.id,
			});
			await bb.events.appendThread("thread.resume_action", {
				threadId: firstId,
				action: "scroll-up",
			});
			await bb.events.appendThread("thread.resume_note_consumed", {
				threadId: firstId,
				surface: "card-expanded",
			});

			const stats = await collectChatStats(bb);
			expect(stats.forks.total).toBe(2);
			expect(stats.forks.families.count).toBe(1);
			expect(stats.forks.families.largestSize).toBe(3);
			expect(stats.forks.depth.min).toBe(1);
			expect(stats.forks.depth.max).toBe(1);
			expect(stats.lifecycle.switches).toBe(3);
			expect(stats.lifecycle.restores).toBe(1);
			expect(stats.lifecycle.resumeNotesConsumed).toBe(1);
			expect(stats.lifecycle.restoreFirstAction.known).toBe(1);
			expect(stats.lifecycle.restoreFirstAction.byKind["scroll-up"]).toBe(1);
			expect(stats.siblingAlternation.available).toBe(true);
			expect(stats.siblingAlternation.alternatingFamilies).toBe(1);
			expect(stats.siblingAlternation.transitions).toBe(2);
		} finally {
			await cleanup();
		}
	});
});
