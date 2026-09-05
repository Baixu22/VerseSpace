import { describe, expect, test } from "bun:test";
import type { ReadSetDiff, ReadSetFact } from "../runtime/read-set-diff";
import type { ResumeNote } from "./resume";
import {
	buildResumeCard,
	FORBIDDEN_CARD_PHRASES,
	type ResumeCardView,
} from "./resume-card";

/**
 * TF-0129：覆盖率行与文案黑名单。恢复卡是对一个**部分**读集的事实核对，
 * 因此它无权说出「无变化」或「安全」——读集可能什么都没覆盖到。
 */

function note(): ResumeNote {
	return {
		beats: [{ kind: "doing", text: "在改登录流程", refs: ["footprint:e-1"] }],
		draftedAt: "2026-09-05T10:00:00.000Z",
		leaveSignature: {
			lastMessageAt: "2026-09-05T09:59:00.000Z",
			messageCount: 2,
			footprintSeq: 3,
			eventSeq: 10,
			eventId: "e-leave",
		},
	};
}

function fact(path: string): ReadSetFact {
	return {
		path,
		observedVersion: "h0h0h0h0h0",
		currentVersion: "h2h2h2h2h2",
		writerId: "git",
		writerKind: "git",
		writerLabel: "git（hook 捕获）",
		refs: ["footprint:e-1", "eventSeq:12"],
		observedFootprintSeq: 2,
		currentEventSeq: 12,
	};
}

function diff(partial: Partial<ReadSetDiff> = {}): ReadSetDiff {
	return {
		status: "available",
		baseline: { footprintSeq: 3, eventSeq: 10, eventId: "e-leave" },
		checkedAt: "2026-09-05T11:00:00.000Z",
		compared: 0,
		comparable: 0,
		excludedDurable: 0,
		excludedDirectories: 0,
		unsupported: 0,
		uncoveredTools: [],
		stale: [],
		...partial,
	};
}

/** Every string the card would render, flattened. */
function renderedText(card: ResumeCardView): string {
	return [
		card.coverage.text,
		...card.narrative.map((row) => row.text + (row.annotation?.label ?? "")),
		...card.facts.map(
			(row) => `${row.path} ${row.summary} ${row.annotation?.label ?? ""}`,
		),
	].join("\n");
}

describe("覆盖率行是 facts 段首行（TF-0129 验收六）", () => {
	test("有可比对时给出 读取数 / 可比对数 / 已变数", () => {
		const card = buildResumeCard({
			note: note(),
			diff: diff({ compared: 5, comparable: 4, stale: [fact("src/a.ts")] }),
		});
		expect(card).not.toBeNull();
		expect(card!.coverage.status).toBe("available");
		expect(card!.coverage.compared).toBe(5);
		expect(card!.coverage.comparable).toBe(4);
		expect(card!.coverage.changed).toBe(1);
		expect(card!.coverage.text).toContain("覆盖率");
		expect(card!.coverage.text).toContain("5");
		expect(card!.coverage.text).toContain("4");
	});

	test("覆盖率不占 facts 槽位，也不可能被预览截断掉", () => {
		const card = buildResumeCard({
			note: note(),
			diff: diff({
				compared: 9,
				comparable: 9,
				stale: [fact("a.ts"), fact("b.ts"), fact("c.ts"), fact("d.ts")],
			}),
		});
		// facts 里全是真实分歧行，覆盖率单独一个字段：任何 preview 切法都切不掉它
		expect(card!.facts).toHaveLength(4);
		expect(card!.facts.map((row) => row.path)).not.toContain(
			card!.coverage.text,
		);
		expect(card!.coverage.text.length).toBeGreaterThan(0);
	});

	test("剔除的目录检索与可复现文件都在行里说清楚（验收四）", () => {
		const card = buildResumeCard({
			note: note(),
			diff: diff({
				compared: 2,
				comparable: 2,
				excludedDirectories: 7,
				excludedDurable: 3,
				stale: [fact("src/a.ts")],
			}),
		});
		expect(card!.coverage.excludedDirectories).toBe(7);
		expect(card!.coverage.text).toContain("7 个目录检索");
		expect(card!.coverage.text).toContain("3 个可复现文件");
	});

	test("未覆盖的工具被列出，不是静默省略（验收三）", () => {
		const card = buildResumeCard({
			note: note(),
			diff: diff({
				compared: 4,
				comparable: 2,
				unsupported: 2,
				uncoveredTools: ["NotebookRead", "Read"],
				stale: [fact("src/a.ts")],
			}),
		});
		expect(card!.coverage.text).toContain("未覆盖的工具");
		expect(card!.coverage.text).toContain("NotebookRead");
	});
});

describe("无覆盖时说未知，不说没事（TF-0129 验收三）", () => {
	test("comparable = 0：状态 unknown，明说没有依据", () => {
		const card = buildResumeCard({
			note: note(),
			diff: diff({ compared: 6, comparable: 0, unsupported: 6 }),
		});
		expect(card!.coverage.status).toBe("unknown");
		expect(card!.coverage.text).toContain("覆盖范围未知");
		expect(card!.coverage.text).toContain("没有依据");
	});

	test("没有基线（diff = null / status unknown）：同样是 unknown，不是零变化", () => {
		for (const input of [null, diff({ status: "unknown", baseline: null })]) {
			const card = buildResumeCard({ note: note(), diff: input });
			expect(card!.coverage.status).toBe("unknown");
			expect(card!.coverage.text).toContain("覆盖范围未知");
		}
	});
});

describe("文案黑名单（TF-0129 验收一、五）", () => {
	const cases: Array<[string, Parameters<typeof buildResumeCard>[0]]> = [
		[
			"有分歧",
			{
				note: note(),
				diff: diff({ compared: 3, comparable: 3, stale: [fact("src/a.ts")] }),
			},
		],
		[
			"零分歧但有笔记",
			{ note: note(), diff: diff({ compared: 3, comparable: 3 }) },
		],
		[
			"零可比对",
			{
				note: note(),
				diff: diff({ compared: 3, comparable: 0, unsupported: 3 }),
			},
		],
		["无基线", { note: note(), diff: null }],
		[
			"只有事实没有笔记",
			{
				note: null,
				diff: diff({ compared: 1, comparable: 1, stale: [fact("src/a.ts")] }),
			},
		],
		[
			"全部剔除",
			{
				note: note(),
				diff: diff({ compared: 0, comparable: 0, excludedDirectories: 4 }),
			},
		],
	];

	for (const [label, input] of cases) {
		test(`${label}：渲染输出里不出现任何一条禁用措辞`, () => {
			const card = buildResumeCard(input);
			expect(card).not.toBeNull();
			const text = renderedText(card!);
			for (const phrase of FORBIDDEN_CARD_PHRASES) {
				expect(text).not.toContain(phrase);
			}
		});
	}

	test("黑名单本身覆盖三条点名的措辞", () => {
		for (const phrase of ["无变化", "没有变化", "安全"]) {
			expect(FORBIDDEN_CARD_PHRASES as readonly string[]).toContain(phrase);
		}
	});
});

describe("其余不变式", () => {
	test("无笔记且无分歧仍然整卡不渲染（TF-0128 不被覆盖率行推翻）", () => {
		expect(
			buildResumeCard({
				note: null,
				diff: diff({ compared: 12, comparable: 12 }),
			}),
		).toBeNull();
	});

	test("指标可导出为 JSON（验收二）", () => {
		const card = buildResumeCard({
			note: note(),
			diff: diff({
				compared: 5,
				comparable: 4,
				excludedDirectories: 2,
				uncoveredTools: ["Grep"],
				stale: [fact("src/a.ts")],
			}),
		});
		const round = JSON.parse(JSON.stringify(card)) as ResumeCardView;
		expect(round.coverage).toEqual(card!.coverage);
		expect(round.coverage.uncoveredTools).toEqual(["Grep"]);
	});
});
