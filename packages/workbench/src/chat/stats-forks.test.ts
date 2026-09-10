import { expect, test } from "bun:test";
import type { WorkbenchEvent } from "../types/event";
import { siblingAlternation } from "./stats-forks";
import type { ThreadMeta } from "./threads";

const START = Date.parse("2026-09-07T00:00:00Z");

function thread(id: string, parent?: string): ThreadMeta {
	return {
		id,
		title: id,
		createdAt: new Date(START).toISOString(),
		status: "idle",
		permissionMode: "default",
		...(parent
			? {
					forkOf: {
						sourceThreadId: parent,
						sourceTitle: parent,
						anchorMessageId: "anchor",
						inheritedMessages: 1,
						at: new Date(START).toISOString(),
					},
				}
			: {}),
	};
}

function switches(
	a: string,
	b: string,
	minutes: readonly number[] = [0, 1, 2],
): WorkbenchEvent[] {
	return minutes.map((minute, index) => ({
		type: "thread.switch",
		source: "threads",
		eventSeq: index + 1,
		timestamp: new Date(START + minute * 60_000).toISOString(),
		payload: {
			fromThreadId: index % 2 === 0 ? a : b,
			toThreadId: index % 2 === 0 ? b : a,
		},
	}));
}

function measure(threads: ThreadMeta[], events: WorkbenchEvent[]) {
	const parents = new Map(
		threads.flatMap((item) =>
			item.forkOf ? [[item.id, item.forkOf.sourceThreadId] as const] : [],
		),
	);
	return siblingAlternation(threads, events, parents);
}

test("兄弟交替分母包含未切换的家族：十个家族用过一个是 10%", () => {
	const threads = Array.from({ length: 10 }, (_, i) => [
		thread(`root-${i}`),
		thread(`a-${i}`, `root-${i}`),
		thread(`b-${i}`, `root-${i}`),
	]).flat();
	expect(measure(threads, switches("a-0", "b-0"))).toMatchObject({
		available: true,
		families: 10,
		alternatingFamilies: 1,
		rate: 0.1,
	});
});

test("同一根家族的多层兄弟交替只计一个家族", () => {
	const threads = [
		thread("root"),
		thread("a", "root"),
		thread("b", "root"),
		thread("a1", "a"),
		thread("a2", "a"),
		thread("quiet"),
		thread("quiet-child", "quiet"),
	];
	const events = [
		...switches("a", "b"),
		...switches("a1", "a2", [3, 4, 5]),
	].map((event, index) => ({ ...event, eventSeq: index + 1 }));
	expect(measure(threads, events)).toMatchObject({
		families: 2,
		alternatingFamilies: 1,
		transitions: 4,
		rate: 0.5,
	});
});

test.each([
	{ label: "整体超过窗口", minutes: [0, 20, 40] },
	{ label: "两段分散交替", minutes: [0, 1, 40, 41] },
	{ label: "时间戳倒退", minutes: [2, 1, 0] },
])("分散的交替或倒退时钟不凑成 30 分钟窗口：$label", ({ minutes }) => {
	const result = measure(
		[thread("root"), thread("a", "root"), thread("b", "root")],
		switches("a", "b", minutes),
	);
	expect(result.alternatingFamilies).toBe(0);
	expect(result.rate).toBe(0);
});

test("30 分钟边界包含在窗口内；没有观测时保持 unknown", () => {
	const threads = [thread("root"), thread("a", "root"), thread("b", "root")];
	expect(measure(threads, switches("a", "b", [0, 15, 30])).rate).toBe(1);
	expect(measure(threads, [])).toMatchObject({
		available: false,
		families: 1,
		rate: null,
	});
});
