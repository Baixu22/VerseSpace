import { describe, expect, test } from "bun:test";
import { collectChatStats } from "../chat/stats";
import { makeTempWorkbench } from "../test/fixtures";
import type { WorkbenchEvent } from "../types/event";
import {
	foldNoticeOutcomes,
	labelNoticeOutcomes,
	type NoticeOutcome,
} from "./notice-outcome";
import { SEAL_EVENT } from "./seal-counts";

/**
 * TF-0148：通知结局标注。标注只读日志里已有的东西——足迹轮次与封印决策，
 * 不新增任何用户输入（验收四）。
 */

let seq = 0;

function event(
	type: string,
	source: string,
	payload: Record<string, unknown>,
): WorkbenchEvent {
	seq += 1;
	return {
		timestamp: new Date(Date.UTC(2026, 8, 5, 0, 0, seq)).toISOString(),
		source,
		type,
		payload,
		eventSeq: seq,
	};
}

/** One `premise_stale` + one delivery for `writer` naming `paths`. */
function delivered(
	writer: string,
	paths: string[],
	extra: Record<string, unknown> = {},
): WorkbenchEvent[] {
	const noticeId = `notice-${writer}-${seq + 1}`;
	return [
		event("premise_stale", "runtime", {
			writer,
			noticeId,
			stale: paths.map((path) => ({
				path,
				observedVersion: "aaa",
				currentVersion: "bbb",
			})),
		}),
		event("premise_notice_delivered", "runtime", {
			writer,
			noticeIds: [noticeId],
			count: 1,
			readObservability: "footprint",
			...extra,
		}),
	];
}

function footprint(
	writer: string,
	used: string[],
	generated: string[],
): WorkbenchEvent {
	return event("footprint", "sessions", {
		writer,
		activity: "a",
		agent: writer,
		used: used.map((path) => ({ path, durability: "volatile" })),
		generated: generated.map((path) => ({ path })),
	});
}

function sealBlock(writer: string, path: string): WorkbenchEvent {
	return event(SEAL_EVENT, "runtime", {
		writer,
		path,
		decision: "block",
		hit: true,
		matchedDeclarations: [path],
		mode: "block",
		effectiveMode: "block",
		downgraded: false,
	});
}

function only(events: WorkbenchEvent[]): NoticeOutcome {
	const labeled = labelNoticeOutcomes(events);
	expect(labeled).toHaveLength(1);
	return labeled[0]!.outcome;
}

describe("四态标注各有一条真实事件样本（TF-0148 验收一）", () => {
	test("repaired：重读受影响文件后再写", () => {
		expect(
			only([
				...delivered("w", ["src/a.ts"]),
				footprint("w", ["src/a.ts"], []),
				footprint("w", [], ["src/a.ts"]),
			]),
		).toBe("repaired");
	});

	test("repaired：同一轮里读完就改也算", () => {
		expect(
			only([
				...delivered("w", ["src/a.ts"]),
				footprint("w", ["src/a.ts"], ["src/a.ts"]),
			]),
		).toBe("repaired");
	});

	test("ignored：没重读就直接改（最危险的一态）", () => {
		expect(
			only([...delivered("w", ["src/a.ts"]), footprint("w", [], ["src/a.ts"])]),
		).toBe("ignored");
	});

	test("sealed：写入在封印点被拦下", () => {
		expect(
			only([
				...delivered("w", ["src/a.ts"]),
				sealBlock("w", "src/a.ts"),
				footprint("w", [], ["src/a.ts"]),
			]),
		).toBe("sealed");
	});

	test("dismissed：继续干活，但再没碰过那些文件", () => {
		expect(
			only([
				...delivered("w", ["src/a.ts"]),
				footprint("w", ["src/other.ts"], ["src/other.ts"]),
			]),
		).toBe("dismissed");
	});

	test("unknown：写者还没再跑过，不猜（验收五）", () => {
		const labeled = labelNoticeOutcomes(delivered("w", ["src/a.ts"]));
		expect(labeled[0]!.outcome).toBe("unknown");
		expect(labeled[0]!.unknownReason).toBe("no-later-activity");
	});
});

describe("不猜测的边界（TF-0148 验收五）", () => {
	test("HTTP 供应商的读不可观测：标 unknown，不读沉默为 dismissed", () => {
		const labeled = labelNoticeOutcomes([
			...delivered("w", ["src/a.ts"], { readObservability: "unobservable" }),
			footprint("w", ["src/other.ts"], ["src/other.ts"]),
		]);
		expect(labeled[0]!.outcome).toBe("unknown");
		expect(labeled[0]!.unknownReason).toBe("unobservable");
	});

	test("不可观测的通道仍然可以被封印：seal 是 hook，不依赖读观测", () => {
		expect(
			only([
				...delivered("w", ["src/a.ts"], { readObservability: "unobservable" }),
				sealBlock("w", "src/a.ts"),
			]),
		).toBe("sealed");
	});

	test("路径还原不出来时标 unresolved-paths，不假装是 dismissed", () => {
		const labeled = labelNoticeOutcomes([
			event("premise_notice_delivered", "runtime", {
				writer: "w",
				noticeIds: ["notice-missing"],
			}),
			footprint("w", ["src/a.ts"], []),
		]);
		expect(labeled[0]!.outcome).toBe("unknown");
		expect(labeled[0]!.unknownReason).toBe("unresolved-paths");
	});

	test("别的写者的足迹与封印都不算在这条通知头上", () => {
		expect(
			only([
				...delivered("w", ["src/a.ts"]),
				footprint("other", [], ["src/a.ts"]),
				sealBlock("other", "src/a.ts"),
			]),
		).toBe("unknown");
	});
});

describe("归属与优先级", () => {
	test("ignored 不被同一条通知里另一个路径的 repaired 掩盖（验收二）", () => {
		expect(
			only([
				...delivered("w", ["src/a.ts", "src/b.ts"]),
				footprint("w", ["src/a.ts"], ["src/a.ts"]),
				footprint("w", [], ["src/b.ts"]),
			]),
		).toBe("ignored");
	});

	test("窗口在同一写者的下一条通知处关闭，不重复计一次反应", () => {
		const events = [
			...delivered("w", ["src/a.ts"]),
			...delivered("w", ["src/b.ts"]),
			footprint("w", ["src/b.ts"], ["src/b.ts"]),
		];
		const labeled = labelNoticeOutcomes(events);
		expect(labeled).toHaveLength(2);
		// 第一条：窗口在第二条通知处就关了，只剩「还没再跑」
		expect(labeled[0]!.outcome).toBe("unknown");
		expect(labeled[1]!.outcome).toBe("repaired");
	});

	test("目录级 claim：改目录下的文件同样算触碰", () => {
		expect(
			only([...delivered("w", ["src"]), footprint("w", [], ["src/deep/a.ts"])]),
		).toBe("ignored");
	});
});

describe("校准表（TF-0148 验收三）", () => {
	test("agent 结局与人侧动作并列，ignored 单独可读", () => {
		const folded = foldNoticeOutcomes([
			...delivered("w1", ["src/a.ts"]),
			footprint("w1", [], ["src/a.ts"]),
			...delivered("w2", ["src/b.ts"]),
			footprint("w2", ["src/b.ts"], ["src/b.ts"]),
			event("thread.resume_note_consumed", "threads", { threadId: "t-1" }),
			event("thread.resume_action", "threads", {
				threadId: "t-1",
				action: "resume_card_dismissed",
			}),
			event("thread.resume_action", "threads", {
				threadId: "t-1",
				action: "scroll_up",
			}),
		]);
		expect(folded.agent.delivered).toBe(2);
		expect(folded.agent.ignored).toBe(1);
		expect(folded.agent.repaired).toBe(1);
		expect(folded.human.notesConsumed).toBe(1);
		expect(folded.human.dismissed).toBe(1);
		expect(folded.human.actions).toBe(2);
		expect(folded.human.byAction.resume_card_dismissed).toBe(1);
		// 行数 = 标注过的投递 + 人侧动作 + 笔记消费，供 30 天护城河口径读
		expect(folded.rows).toBe(5);
		expect(folded.ignoredRatio).toBe(0.5);
		expect(folded.dismissedRatio).toBe(0);
	});

	test("没有投递时两个比值是 null 而不是 0", () => {
		const folded = foldNoticeOutcomes([]);
		expect(folded.agent.delivered).toBe(0);
		expect(folded.ignoredRatio).toBeNull();
		expect(folded.dismissedRatio).toBeNull();
		expect(folded.rows).toBe(0);
	});
});

describe("stats 里能读到校准表", () => {
	test("真实黑板上的投递与结局进入 workbench stats", async () => {
		const ws = await makeTempWorkbench();
		try {
			for (const item of [
				...delivered("w", ["src/a.ts"]),
				footprint("w", [], ["src/a.ts"]),
			]) {
				await ws.bb.events.append({
					timestamp: item.timestamp,
					source: item.source,
					type: item.type,
					payload: item.payload,
				});
			}
			const stats = await collectChatStats(ws.bb);
			expect(stats.noticeOutcomes.agent.delivered).toBe(1);
			expect(stats.noticeOutcomes.agent.ignored).toBe(1);
			expect(stats.noticeOutcomes.rows).toBe(1);
		} finally {
			await ws.cleanup();
		}
	});
});
