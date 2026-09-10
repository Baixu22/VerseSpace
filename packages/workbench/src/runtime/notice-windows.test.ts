import { expect, test } from "bun:test";
import type { WorkbenchEvent } from "../types/event";
import { labelNoticeOutcomes } from "./notice-outcome";

const event = (
	id: string,
	type: string,
	payload: Record<string, unknown>,
): WorkbenchEvent => ({
	id,
	type,
	source: "runtime",
	timestamp: "2026-09-07T00:00:00Z",
	payload,
});
const read = (id: string) =>
	event(id, "footprint", {
		writer: "w",
		used: [{ path: "src/a.ts" }],
		generated: [],
	});
const write = (id: string) =>
	event(id, "footprint", {
		writer: "w",
		used: [],
		generated: [{ path: "src/a.ts" }],
	});
const ack = (id: string, marker?: string) =>
	event(id, "premise_notice_delivered", {
		writer: "w",
		noticeId: id,
		stale: [{ path: "src/a.ts" }],
		activityAfterEventId: marker,
	});

test("deferred acknowledgement includes same-turn reads but excludes a failed earlier attempt", () => {
	const start = event("start", "premise_notice_queued", { writer: "w" });
	expect(
		labelNoticeOutcomes([start, read("read"), ack("ack", "start")])[0]?.outcome,
	).toBe("repaired");
	expect(
		labelNoticeOutcomes([
			read("failed-read"),
			start,
			write("blind-write"),
			ack("ack", "start"),
		])[0]?.outcome,
	).toBe("ignored");
});

test("one response cannot repair two deliveries; invalid markers cannot claim past reads", () => {
	const start = event("start", "premise_notice_queued", { writer: "w" });
	const outcomes = labelNoticeOutcomes([
		ack("first"),
		start,
		read("read"),
		ack("second", "start"),
	]);
	expect(outcomes.map((row) => row.outcome)).toEqual(["unknown", "repaired"]);
	for (const marker of [undefined, "missing", "future"]) {
		expect(
			labelNoticeOutcomes([
				read("read"),
				ack("ack", marker),
				event("future", "other", {}),
			])[0]?.outcome,
		).toBe("unknown");
	}
});
