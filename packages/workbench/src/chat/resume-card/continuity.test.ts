import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { hashPathClaim } from "../../blackboard/footprint";
import { makeTempWorkbench } from "../../test/fixtures";
import { createUiServer } from "../../ui/server";
import type { ContinuityInterruption } from "../continuity/types";
import { collectRestoreView } from "../restore-view";
import { ChatThreads } from "../threads";
import { continuityCardRows } from "./continuity";
import { buildResumeCard } from "./index";

const AT = "2026-11-01T00:00:00.000Z";

function interruption(
	overrides: Partial<ContinuityInterruption> = {},
): ContinuityInterruption {
	return {
		at: AT,
		eventId: "evt-interrupt-1",
		messageCount: 1,
		reason: "host-restarted",
		recovered: false,
		...overrides,
	};
}

describe("TF-0323 判据：恢复卡上的会话断点行", () => {
	test("判据 1：intact 不产生任何行（健康不占空间）", () => {
		const projection = continuityCardRows({
			state: "intact",
			interruptions: [interruption({ recovered: true })],
			pendingNotices: 0,
		});
		expect(projection.rows).toEqual([]);
		expect(projection.state).toBe("intact");
	});

	test("判据 1b：unknown 也不产生行——材料缺口由 CLI / MCP 报告，卡片不说话", () => {
		const projection = continuityCardRows({
			state: "unknown",
			interruptions: [],
			pendingNotices: 0,
		});
		expect(projection.rows).toEqual([]);
	});

	test("判据 2：未恢复的中断恰好一行，refs 指向 event:<id>", () => {
		const projection = continuityCardRows({
			state: "review",
			interruptions: [interruption()],
			pendingNotices: 0,
		});
		expect(projection.rows).toHaveLength(1);
		const row = projection.rows[0]!;
		expect(row.source).toBe("interruption");
		expect(row.refs).toEqual(["event:evt-interrupt-1"]);
		expect(row.summary).toContain("host-restarted");
		expect(row.summary).toContain("之后没有助手回复");
	});

	test("判据 2b：已恢复的中断不进卡片（记录保留但不占注意力）", () => {
		const projection = continuityCardRows({
			state: "review",
			interruptions: [
				interruption({ eventId: "old", recovered: true }),
				interruption({ eventId: "new", recovered: false }),
			],
			pendingNotices: 0,
		});
		expect(projection.rows).toHaveLength(1);
		expect(projection.rows[0]!.refs).toEqual(["event:new"]);
	});

	test("判据 2c：没有事件身份的旧记录仍然成行，但不伪造引用", () => {
		const projection = continuityCardRows({
			state: "review",
			interruptions: [interruption({ eventId: null, messageCount: null })],
			pendingNotices: 0,
		});
		expect(projection.rows).toHaveLength(1);
		expect(projection.rows[0]!.refs).toEqual([]);
		expect(projection.rows[0]!.summary).toContain("条数未记录");
	});

	test("判据 3：积压只进头部计数，不变成事实行", () => {
		const projection = continuityCardRows({
			state: "review",
			interruptions: [interruption()],
			pendingNotices: 20,
		});
		expect(projection.delivery.pendingNotices).toBe(20);
		// 事实区只有那一行断点：积压没有变成行
		expect(projection.rows).toHaveLength(1);
		expect(projection.rows.every((row) => row.source === "interruption")).toBe(
			true,
		);
	});

	test("判据 4：断点行排在事实区最前并计入 pinnedFacts（不被预览折叠）", () => {
		const projection = continuityCardRows({
			state: "review",
			interruptions: [interruption()],
			pendingNotices: 0,
		});
		const card = buildResumeCard({
			note: {
				beats: [{ kind: "next", text: "接着做恢复卡", refs: ["message:m-1"] }],
				draftedAt: AT,
				leaveSignature: { lastMessageAt: AT, messageCount: 1 },
			},
			diff: null,
			continuityFacts: projection.rows,
		});
		expect(card).not.toBeNull();
		expect(card!.facts[0]!.source).toBe("interruption");
		expect(card!.pinnedFacts).toBe(1);
	});

	test("判据 4b：只有断点、没有笔记与文件事实时卡片仍然渲染", () => {
		const projection = continuityCardRows({
			state: "review",
			interruptions: [interruption()],
			pendingNotices: 0,
		});
		const card = buildResumeCard({
			note: null,
			diff: null,
			continuityFacts: projection.rows,
		});
		expect(card).not.toBeNull();
		expect(card!.facts).toHaveLength(1);
		expect(card!.pinnedFacts).toBe(1);
	});

	test("判据 5：intact 会话的卡片行数与没有延续性输入时完全一致", () => {
		const note = {
			beats: [{ kind: "next" as const, text: "接着做", refs: ["message:m-1"] }],
			draftedAt: AT,
			leaveSignature: { lastMessageAt: AT, messageCount: 1 },
		};
		const without = buildResumeCard({ note, diff: null });
		const withIntact = buildResumeCard({
			note,
			diff: null,
			continuityFacts: continuityCardRows({
				state: "intact",
				interruptions: [],
				pendingNotices: 0,
			}).rows,
		});
		expect(withIntact!.facts).toEqual(without!.facts);
		expect(withIntact!.pinnedFacts).toBe(0);
	});
});

describe("TF-0324：restore-view 接入延续性投影", () => {
	test("intact 会话：恢复卡行数不变，断点数为 0", async () => {
		const ws = await makeTempWorkbench();
		try {
			const chat = new ChatThreads(ws.bb);
			const thread = await chat.create("健康会话");
			await writeFile(
				join(ws.workbenchRoot, "threads", thread.id, "messages.jsonl"),
				`${JSON.stringify({ id: "m-1", role: "user", text: "继续", at: AT })}\n${JSON.stringify({ id: "m-2", role: "assistant", text: "做完了", at: AT })}\n`,
				"utf8",
			);
			const view = await collectRestoreView(ws.bb, chat, thread.id);
			// intact 会话没有任何待办事实，因此恢复卡根本不渲染——与没有延续性
			// 投影时同形（健康不占空间这条判据的最强形式）。
			expect(view.resumeCard).toBeNull();
			expect(view.continuityDelivery.pendingNotices).toBe(0);
		} finally {
			await ws.cleanup();
		}
	});

	test("被切断的会话：卡片恰好多一行，refs 能在证据接口里打开", async () => {
		const ws = await makeTempWorkbench();
		const chat = new ChatThreads(ws.bb);
		const server = await createUiServer(ws.bb, 0);
		try {
			await mkdir(join(ws.projectDir, "src"));
			await writeFile(join(ws.projectDir, "src/a.ts"), "export const a = 1;\n");
			const thread = await chat.create("被切断的会话");
			await writeFile(
				join(ws.workbenchRoot, "threads", thread.id, "messages.jsonl"),
				`${JSON.stringify({ id: "m-1", role: "user", text: "继续实现", at: AT })}\n`,
				"utf8",
			);
			// 离开 → 读集基线 → 期间文件被改写（保证卡片本来也有文件事实）。
			await ws.bb.sessions.recordActivity(thread.id, {
				activity: "read-a",
				agent: thread.id,
				used: [await hashPathClaim(ws.projectDir, "src/a.ts")],
				generated: [],
			});
			await chat.leave(thread.id);
			await writeFile(join(ws.projectDir, "src/a.ts"), "export const a = 2;\n");
			await ws.bb.sessions.recordActivity(thread.id, {
				activity: "write-a",
				agent: "human",
				used: [],
				generated: [await hashPathClaim(ws.projectDir, "src/a.ts")],
			});
			// 启动清扫发现 status=running：先落中断观察再复位。
			const metaFile = join(
				ws.workbenchRoot,
				"threads",
				thread.id,
				"meta.json",
			);
			const meta = JSON.parse(await Bun.file(metaFile).text()) as {
				status: string;
			};
			meta.status = "running";
			await writeFile(metaFile, JSON.stringify(meta, null, 2), "utf8");
			expect(await new ChatThreads(ws.bb).reconcileRunningOnStartup()).toBe(1);

			const view = await collectRestoreView(ws.bb, chat, thread.id);
			const rows = view.resumeCard?.facts ?? [];
			const interruptions = rows.filter((row) => row.source === "interruption");
			// 判据：恰好一行断点，且排在最前
			expect(interruptions).toHaveLength(1);
			expect(rows[0]!.source).toBe("interruption");
			expect(view.resumeCard!.pinnedFacts).toBe(1);
			// 文件事实仍在（没有因为断点行把别的事实挤掉）
			expect(rows.some((row) => row.source === "read-set")).toBe(true);

			// refs 能在证据接口里打开（event:<id> 解析到原始事件）
			const ref = interruptions[0]!.refs[0]!;
			expect(ref.startsWith("event:")).toBe(true);
			const response = await server.handle(
				new Request(
					`http://127.0.0.1:${server.port}/api/chat/threads/${thread.id}/evidence?ref=${encodeURIComponent(ref)}`,
					{ headers: { "x-workbench-token": server.authToken } },
				),
			);
			expect(response.ok).toBe(true);
			const evidence = (await response.json()) as {
				kind: string;
				title: string;
			};
			expect(evidence.kind).toBe("event");
			expect(evidence.title).toContain("thread.turn_interrupted");
		} finally {
			server.stop(true);
			await ws.cleanup();
		}
	});

	test("刷新两次得到同一份读数：GET 不落事件（只读边界）", async () => {
		const ws = await makeTempWorkbench();
		try {
			const chat = new ChatThreads(ws.bb);
			const thread = await chat.create("反复刷新");
			await ws.bb.events.appendThread("thread.turn_interrupted", {
				threadId: thread.id,
				at: AT,
				atMessageCount: 0,
				reason: "host-restarted",
			});
			const before = (await ws.bb.events.all()).length;
			const first = await collectRestoreView(ws.bb, chat, thread.id);
			const second = await collectRestoreView(ws.bb, chat, thread.id);
			const after = (await ws.bb.events.all()).length;
			expect(after).toBe(before);
			expect(second.resumeCard?.facts).toEqual(first.resumeCard?.facts);
			expect(second.resumeCard?.pinnedFacts).toBe(
				first.resumeCard?.pinnedFacts,
			);
		} finally {
			await ws.cleanup();
		}
	});
});
