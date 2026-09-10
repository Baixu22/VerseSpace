import { expect, test } from "bun:test";
import { makeTempWorkbench } from "../test/fixtures";
import type { WorkbenchEvent } from "../types/event";
import { drainPremiseQueue, pendingPremiseNotices } from "./delivery";
import { foldNoticeFamilies } from "./notice-family";
import { noticeIdForClaims } from "./notice-id";
import { renderNotice } from "./notice-render";

const NOW = Date.parse("2026-09-07T06:00:00Z");
const event = (
	type: string,
	payload: unknown,
	age = 1_000,
): WorkbenchEvent => ({
	type,
	payload,
	source: "test",
	timestamp: new Date(NOW - age).toISOString(),
});
const lineage = [
	event("thread.forked", { threadId: "b", sourceThreadId: "a" }),
	event("thread.forked", { threadId: "c", sourceThreadId: "a" }),
];
const claim = (path: string) => ({
	path,
	observedVersion: "old",
	currentVersion: "new",
});

test("同家族近期写入折叠；过期、外部作者、版本不符和坏血缘不折叠", () => {
	const notices = [{ writerId: "a", claims: [claim("src/a.ts")] }];
	const write = event("footprint", {
		writer: "b",
		generated: [{ path: "src/a.ts", version: "new" }],
	});
	const folded = foldNoticeFamilies(notices, [...lineage, write], NOW).get("a");
	expect(folded).toEqual({
		familyId: "a",
		windowMinutes: 30,
		writerIds: ["b"],
		paths: ["src/a.ts"],
	});
	for (const extra of [
		{ ...write, timestamp: new Date(NOW - 31 * 60_000).toISOString() },
		{
			...write,
			payload: {
				writer: "external",
				generated: [{ path: "src/a.ts", version: "new" }],
			},
		},
		{
			...write,
			payload: {
				writer: "b",
				generated: [{ path: "src/a.ts", version: "different" }],
			},
		},
		{ ...write, payload: { generated: [{ path: "src/a.ts" }] } },
	])
		expect(
			foldNoticeFamilies(notices, [...lineage, write, extra], NOW).size,
		).toBe(0);
	const cycle = event("thread.forked", { threadId: "a", sourceThreadId: "b" });
	expect(
		foldNoticeFamilies(notices, [...lineage, cycle, write], NOW).size,
	).toBe(0);
	expect(
		foldNoticeFamilies(
			notices,
			[...lineage, { ...write, timestamp: "invalid" }],
			NOW,
		).size,
	).toBe(0);
	// An exact 30-minute boundary is eligible; a future write is not evidence yet.
	expect(
		foldNoticeFamilies(
			notices,
			[
				...lineage,
				{ ...write, timestamp: new Date(NOW - 30 * 60_000).toISOString() },
			],
			NOW,
		).size,
	).toBe(1);
	expect(
		foldNoticeFamilies(
			notices,
			[...lineage, { ...write, timestamp: new Date(NOW + 1).toISOString() }],
			NOW,
		).size,
	).toBe(0);
});

test("家族多文件只占一行，显示剩余总数，外部作者事实保持独立", () => {
	const family = Array.from({ length: 5 }, (_, index) => ({
		...claim(`family-${index}.ts`),
		diff: "large diff\n".repeat(100),
	}));
	const claims = [claim("external.ts"), ...family];
	const message = renderNotice(
		claims,
		300,
		new Set(family.map((item) => item.path)),
	);
	expect(message).toContain("- external.ts\n  观察版本 old → 当前版本 new");
	expect(message).toContain("同一分叉家族近 30 分钟改动 5 个文件（已折叠）");
	expect(message).toContain("及另 2 条");
	expect(message.match(/^- /gm)).toHaveLength(2);
	expect(message).not.toContain("```diff");
	expect(message.length).toBeLessThanOrEqual(1_200);
});

test("三路分叉各收一束，折叠不删除事实、不共用确认，也不改通知身份", async () => {
	const ws = await makeTempWorkbench();
	try {
		for (const writer of ["a", "b", "c"])
			await ws.bb.sessions.register(writer, "agent", writer);
		await ws.bb.events.appendThread("thread.forked", {
			threadId: "b",
			sourceThreadId: "a",
		});
		await ws.bb.events.appendThread("thread.forked", {
			threadId: "c",
			sourceThreadId: "a",
		});
		for (const [writer, path] of [
			["a", "from-a.ts"],
			["b", "from-b.ts"],
			["c", "from-c.ts"],
		]) {
			await ws.bb.sessions.recordActivity(writer!, {
				activity: "write",
				agent: writer!,
				used: [],
				generated: [{ path: path!, version: "new" }],
			});
		}
		for (const writer of ["a", "b", "c"]) {
			const stale = ["a", "b", "c"]
				.filter((other) => other !== writer)
				.map((other) => claim(`from-${other}.ts`));
			await ws.bb.events.append({
				timestamp: new Date().toISOString(),
				source: "runtime",
				type: "premise_stale",
				payload: { writer, stale, noticeId: noticeIdForClaims(writer, stale) },
			});
		}
		const before = await ws.bb.events.all();
		const pending = await pendingPremiseNotices(ws.bb);
		expect(pending).toHaveLength(3);
		for (const notice of pending) {
			expect(notice.claims).toHaveLength(2);
			expect(notice.familyFold?.paths).toHaveLength(2);
			expect(notice.noticeId).toBe(
				noticeIdForClaims(notice.writerId, notice.claims),
			);
			expect(notice.message.match(/^- /gm)).toHaveLength(1);
		}
		expect(await ws.bb.events.all()).toEqual(before);
		const calls: string[] = [];
		const result = await drainPremiseQueue(ws.bb, {
			deliver: async (writer) => {
				calls.push(writer);
				return writer !== "b";
			},
		});
		expect(calls.sort()).toEqual(["a", "b", "c"]);
		expect(result.delivered).toHaveLength(2);
		expect(result.pending.map((item) => item.writerId)).toEqual(["b"]);
		expect(
			(await pendingPremiseNotices(ws.bb)).map((item) => item.writerId),
		).toEqual(["b"]);
		for (const recorded of await ws.bb.events.query({
			type: "premise_notice_delivered",
		})) {
			expect(recorded.payload).not.toHaveProperty("familyFold");
			expect((recorded.payload as { stale: unknown[] }).stale).toHaveLength(2);
		}
	} finally {
		await ws.cleanup();
	}
});
