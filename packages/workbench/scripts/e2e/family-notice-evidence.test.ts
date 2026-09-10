import { expect, test } from "bun:test";
import type { WorkbenchEvent } from "../../src/types/event";
import { type FamilyNotice, noticeTransition } from "./family-notice-evidence";

const notice: FamilyNotice = {
	writer: "branch-2",
	noticeId: "alpha-branch-2",
	stale: [{ path: "src/alpha.ts", currentVersion: "new" }],
};
const event = (
	type: string,
	payload: Record<string, unknown>,
): WorkbenchEvent => ({
	id: `${type}-id`,
	timestamp: "2026-09-08T00:00:00.000Z",
	source: "runtime",
	type,
	payload: { writer: notice.writer, ...payload },
});
const read = (version: string, writer = notice.writer) =>
	event("footprint", {
		writer,
		used: [{ path: "src/alpha.ts", version }],
	});
const ack = event("premise_notice_delivered", {
	noticeIds: [notice.noticeId],
});

test("S6c：同轮先复读再确认，队列已空仍有独立修复证据", () => {
	expect(noticeTransition(notice, [], [read("new"), ack])).toEqual({
		writer: notice.writer,
		noticeId: notice.noticeId,
		delivery: "delivered",
		deliveryEventId: ack.id ?? null,
		premise: "repaired",
		repairedPaths: ["src/alpha.ts"],
	});
});

test("S6c：待投递和已投递未复读都不冒充修复", () => {
	expect(noticeTransition(notice, [notice], [])).toMatchObject({
		delivery: "pending",
		premise: "not-proven-repaired",
	});
	for (const reads of [
		[],
		[read("old")],
		[read("new", "branch-1")],
		[read("new"), read("old")],
	]) {
		expect(noticeTransition(notice, [], [...reads, ack])).toMatchObject({
			delivery: "delivered",
			premise: "not-proven-repaired",
			repairedPaths: [],
		});
	}
});

test("S6c：队列消失必须有同写者、同通知身份的实际投递记录", () => {
	for (const events of [
		[],
		[read("new")],
		[event("premise_notice_delivered", { noticeId: "other" })],
		[
			event("premise_notice_delivered", {
				writer: "branch-1",
				noticeId: notice.noticeId,
			}),
		],
		[
			event("premise_notice_outcome", {
				noticeId: notice.noticeId,
				outcome: "queued",
			}),
		],
	]) {
		expect(() => noticeTransition(notice, [], events)).toThrow(
			"无独立投递记录",
		);
	}
});

test("S6c：部分复读不算全部修复；待投递记录必须保留全部版本", () => {
	const multiple: FamilyNotice = {
		...notice,
		stale: [...notice.stale, { path: "src/family.ts", currentVersion: "v2" }],
	};
	expect(noticeTransition(multiple, [], [read("new"), ack])).toMatchObject({
		premise: "not-proven-repaired",
		repairedPaths: ["src/alpha.ts"],
	});
	expect(() => noticeTransition(multiple, [notice], [])).toThrow();
	expect(() =>
		noticeTransition(
			notice,
			[{ ...notice, stale: [{ path: "src/alpha.ts", currentVersion: "old" }] }],
			[],
		),
	).toThrow();
});
