import { beforeAll, expect, test } from "bun:test";
import { type ChatStats, collectChatStats } from "../../src/chat/stats";
import { makeTempWorkbench } from "../../src/test/fixtures";
import type { WorkbenchEvent } from "../../src/types/event";
import type { Ctx } from "./metrics";
import { assessVerdicts, parseEvidenceKind } from "./verdicts";

let emptyStats: ChatStats;
beforeAll(async () => {
	const ws = await makeTempWorkbench();
	try {
		emptyStats = await collectChatStats(ws.bb);
	} finally {
		await ws.cleanup();
	}
});

function event(type: string, payload: Record<string, unknown>): WorkbenchEvent {
	return {
		type,
		source: "threads",
		timestamp: "2026-09-07T00:00:00Z",
		payload,
	};
}

function context(): Ctx {
	const stats = structuredClone(emptyStats);
	stats.threads.total = 1;
	Object.assign(stats.lifecycle, {
		restores: 3,
		resumeNotesConsumed: 1,
		resumeActions: 1,
	});
	stats.noticeOutcomes.rows = 10;
	Object.assign(stats.noticeOutcomes.agent, { delivered: 10, repaired: 10 });
	stats.seal.decisions = 3;
	stats.forks.total = 5;
	return {
		stats,
		writerKind: new Map([["thread", "agent"]]),
		events: [
			event("thread.inheritance_observed", {
				threadId: "fork",
				agentContextInherited: true,
				premiseInherited: true,
			}),
		],
	};
}

test("空现场或未声明来源不出支持结论；时间跨度不能代替工程样本", () => {
	const empty: Ctx = {
		stats: structuredClone(emptyStats),
		events: [],
		writerKind: new Map(),
	};
	empty.stats.observation.days = 90;
	expect(
		assessVerdicts(empty, "natural").every(
			(row) => row.status === "insufficient-evidence",
		),
	).toBe(true);
	expect(
		assessVerdicts(context(), "unknown").every(
			(row) => row.status === "insufficient-evidence",
		),
	).toBe(true);
});

test.each([
	"scripted",
	"live-model",
] as const)("%s 支持工程判据，不冒充自然使用给 L3 开门", (kind) => {
	const ctx = context();
	ctx.stats.observation.days = 30;
	expect(assessVerdicts(ctx, kind).map((row) => row.status)).toEqual([
		"supported",
		"supported",
		"supported",
		"insufficient-evidence",
	]);
	expect(assessVerdicts(ctx, kind)[3]!.action).toContain("继续延后 L3");
});

test("一半通知未知：ignored=0 不足以证明 ignored≤10%", () => {
	const ctx = context();
	Object.assign(ctx.stats.noticeOutcomes.agent, { repaired: 5, unknown: 5 });
	const detection = assessVerdicts(ctx, "live-model")[1]!;
	expect(detection.status).toBe("insufficient-evidence");
	expect(detection.readings.at(-1)!.value).toBe(0.5);
});

test("未知结果的最坏情况仍在阈值内时可以支持；已知负样本不被未知遮掉", () => {
	const ctx = context();
	Object.assign(ctx.stats.noticeOutcomes.agent, { repaired: 9, unknown: 1 });
	expect(assessVerdicts(ctx, "live-model")[1]!.status).toBe("supported");
	Object.assign(ctx.stats.noticeOutcomes.agent, {
		repaired: 1,
		ignored: 2,
		unknown: 7,
	});
	expect(assessVerdicts(ctx, "live-model")[1]!.status).toBe("not-supported");
});

test("阈值判定用原始计数，显示舍入不能把 10.01% 改成通过", () => {
	const ctx = context();
	Object.assign(ctx.stats.noticeOutcomes.agent, {
		delivered: 10_000,
		repaired: 8_999,
		ignored: 1_001,
	});
	ctx.stats.noticeOutcomes.ignoredRatio = 0.1;
	expect(assessVerdicts(ctx, "live-model")[1]!.status).toBe("not-supported");
});

test("阶段 C 要求真实上下文与读集继承；仅 transcript 或 HTTP 历史不算", () => {
	const ctx = context();
	ctx.events = [
		event("thread.inheritance_observed", {
			threadId: "fork",
			transcriptInherited: true,
			agentContextInherited: true,
			premiseInherited: false,
		}),
	];
	expect(assessVerdicts(ctx, "live-model")[2]!.status).toBe(
		"insufficient-evidence",
	);
	ctx.events = [...context().events, ...context().events];
	expect(assessVerdicts(ctx, "live-model")[2]!.readings[1]!.value).toBe(1);
});

test("L3 事实消费只读已实现手势；叙事展开与 dismiss 不冒充事实消费", () => {
	const ctx = context();
	ctx.stats.observation.days = 14;
	ctx.stats.forks.perWeek = 1;
	Object.assign(ctx.stats.siblingAlternation, {
		available: true,
		families: 10,
		alternatingFamilies: 3,
		rate: 0.3,
	});
	ctx.events.push(
		event("thread.resume_action", { action: "resume_card_dismissed" }),
		event("thread.resume_action", { action: "resume_card_revealed" }),
	);
	expect(assessVerdicts(ctx, "natural")[3]!.status).toBe("not-supported");
	ctx.events.push(
		event("thread.resume_action", { action: "resume_fact_opened" }),
		event("thread.resume_action", { action: "resume_branch_opened" }),
	);
	const l3 = assessVerdicts(ctx, "natural")[3]!;
	expect(l3.status).toBe("supported");
	expect(l3.readings.at(-1)!.value).toBe(1);
	expect(l3.action).toContain("仅达到复评门槛");
	Object.assign(ctx.stats.siblingAlternation, {
		families: 10_000,
		alternatingFamilies: 2_999,
	});
	expect(assessVerdicts(ctx, "natural")[3]!.status).toBe("not-supported");
});

test("来源参数拒绝拼写错误，不静默猜测 natural", () => {
	expect(parseEvidenceKind("live-model")).toBe("live-model");
	expect(() => parseEvidenceKind("natual")).toThrow("--evidence-kind");
	expect(() => parseEvidenceKind("")).toThrow("--evidence-kind");
});
