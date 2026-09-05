import { describe, expect, test } from "bun:test";
import type { ReadSetDiff, ReadSetFact } from "../runtime/read-set-diff";
import type { ResumeNote } from "./resume";
import {
	annotateClaim,
	buildResumeCard,
	extractPaths,
	isResumeCardDismissed,
	shouldInjectResumeCard,
} from "./resume-card";

function note(beats: ResumeNote["beats"]): ResumeNote {
	return {
		beats,
		draftedAt: "2026-09-04T10:00:00.000Z",
		leaveSignature: {
			lastMessageAt: "2026-09-04T09:59:00.000Z",
			messageCount: 4,
			footprintSeq: 3,
			eventSeq: 10,
			eventId: "e-leave",
		},
	};
}

function fact(
	partial: Partial<ReadSetFact> & Pick<ReadSetFact, "path">,
): ReadSetFact {
	return {
		observedVersion: "h0h0h0h0h0",
		currentVersion: "h2h2h2h2h2",
		writerId: "human",
		writerKind: "human",
		writerLabel: "editor",
		refs: ["footprint:e-1", "eventSeq:12"],
		observedFootprintSeq: 2,
		currentEventSeq: 12,
		...partial,
	};
}

function diff(stale: ReadSetFact[]): ReadSetDiff {
	return {
		status: "available",
		baseline: { footprintSeq: 3, eventSeq: 10, eventId: "e-leave" },
		checkedAt: "2026-09-04T11:00:00.000Z",
		compared: stale.length,
		comparable: stale.length,
		excludedDurable: 0,
		unsupported: 0,
		uncoveredTools: [],
		stale,
	};
}

describe("annotateClaim (TF-0128 conflict rules)", () => {
	test("R1: claimed write still matches current version", () => {
		expect(
			annotateClaim(
				{ path: "src/auth.ts", claimedVersion: "h1" },
				{
					path: "src/auth.ts",
					currentVersion: "h1",
					refs: ["footprint:e-1"],
				},
			),
		).toEqual({ rule: "R1", label: null });
	});

	test("R2: someone else rewrote the file", () => {
		const result = annotateClaim(
			{ path: "src/auth.ts", claimedVersion: "h1" },
			{
				path: "src/auth.ts",
				currentVersion: "h2",
				writerLabel: "branch-c",
				refs: ["eventSeq:12"],
			},
		);
		expect(result.rule).toBe("R2");
		expect(result.label).toContain("branch-c");
	});

	test("R3: rolled back to the pre-write hash", () => {
		const result = annotateClaim(
			{
				path: "src/auth.ts",
				claimedVersion: "h1",
				preWriteVersion: "h0",
			},
			{
				path: "src/auth.ts",
				currentVersion: "h0",
				writerId: "you",
				refs: ["eventSeq:9"],
			},
		);
		expect(result.rule).toBe("R3");
		expect(result.label).toContain("you");
	});

	test("R4: file is gone", () => {
		expect(
			annotateClaim(
				{ path: "src/auth.ts", claimedVersion: "h1" },
				{ path: "src/auth.ts", currentVersion: null, refs: ["eventSeq:9"] },
			),
		).toEqual({ rule: "R4", label: "\u5df2\u88ab\u5220\u9664" });
	});

	test("R5: file moved", () => {
		const result = annotateClaim(
			{ path: "src/auth.ts", movedTo: "src/session.ts" },
			null,
		);
		expect(result).toEqual({
			rule: "R5",
			label: "\u73b0\u5728\u5728 src/session.ts",
		});
	});
});

describe("buildResumeCard (TF-0128)", () => {
	test("no note and no facts -> do not render", () => {
		expect(buildResumeCard({ note: null, diff: null })).toBeNull();
		expect(
			buildResumeCard({
				note: null,
				diff: diff([]),
			}),
		).toBeNull();
	});

	test("facts without refs are dropped; empty card does not render", () => {
		expect(
			buildResumeCard({
				note: null,
				diff: diff([fact({ path: "src/a.ts", refs: [] })]),
			}),
		).toBeNull();
	});

	test("facts-only card renders and every fact row has refs", () => {
		const card = buildResumeCard({
			note: null,
			diff: diff([fact({ path: "src/auth.ts" })]),
		});
		expect(card).not.toBeNull();
		expect(card!.narrative).toEqual([]);
		expect(card!.facts).toHaveLength(1);
		expect(card!.facts[0]!.refs.length).toBeGreaterThan(0);
		expect(card!.inject).toBe(true);
	});

	test("shifted leaves the narrative and lands in the facts section", () => {
		const card = buildResumeCard({
			note: note([
				{
					kind: "doing",
					text: "token refresh",
					refs: ["message:m-1"],
				},
				{
					kind: "shifted",
					text: "\u52a8\u4e86 1 \u5904\uff1aedit(src/auth.ts)",
					refs: ["tool:tc-1", "path:src/auth.ts"],
				},
				{
					kind: "next",
					text: "\u4e0b\u4e00\u6b65\u53ef\u4ee5\uff1arun src/auth.test.ts",
					refs: ["message:m-2"],
				},
			]),
			diff: diff([fact({ path: "src/auth.ts" })]),
		});
		expect(card!.narrative.map((row) => row.kind)).toEqual(["doing", "next"]);
		expect(
			card!.narrative.some((row) => row.kind === ("shifted" as never)),
		).toBe(false);
		expect(card!.facts.map((row) => row.path)).toEqual(["src/auth.ts"]);
		expect(card!.facts[0]!.annotation?.rule).toBe("R2");
		expect(card!.facts[0]!.refs.length).toBeGreaterThan(0);
	});

	test("R6: decided stays as narrative with no repo annotation", () => {
		const card = buildResumeCard({
			note: note([
				{
					kind: "decided",
					text: "\u65b9\u6848\u7532",
					refs: ["ledger:m-3"],
				},
			]),
			diff: diff([fact({ path: "src/auth.ts" })]),
		});
		expect(card!.narrative).toEqual([
			{
				kind: "decided",
				text: "\u65b9\u6848\u7532",
				refs: ["ledger:m-3"],
			},
		]);
	});

	test("R7: reverted promotion annotates decided without rewriting it", () => {
		const card = buildResumeCard({
			note: note([
				{
					kind: "decided",
					text: "\u547d\u540d\u4e3a\u300cauth\u300d",
					refs: ["promotion:auth"],
				},
			]),
			diff: null,
			promotionReverted: true,
		});
		expect(card!.narrative[0]!.text).toBe("\u547d\u540d\u4e3a\u300cauth\u300d");
		expect(card!.narrative[0]!.annotation).toEqual({
			rule: "R7",
			label: "\u5df2\u64a4\u9500",
		});
	});

	test("R8: next step is annotated when a referenced file went stale", () => {
		const card = buildResumeCard({
			note: note([
				{
					kind: "next",
					text: "\u4e0b\u4e00\u6b65\u53ef\u4ee5\uff1arun src/auth.ts tests",
					refs: ["message:m-2"],
				},
			]),
			diff: diff([fact({ path: "src/auth.ts" })]),
		});
		expect(card!.narrative[0]!.text).toContain("src/auth.ts");
		expect(card!.narrative[0]!.annotation).toEqual({
			rule: "R8",
			label: "\u5176\u524d\u63d0\u5df2\u53d8",
		});
	});

	test("R9: shifted beat without refs is omitted", () => {
		const card = buildResumeCard({
			note: note([
				{ kind: "doing", text: "work", refs: ["message:m-1"] },
				{ kind: "shifted", text: "\u52a8\u4e86 src/secret.ts" },
			]),
			diff: null,
		});
		expect(card!.facts).toEqual([]);
		expect(card!.narrative.map((row) => row.kind)).toEqual(["doing"]);
	});

	test("legacy notes without refs still render reminders", () => {
		const card = buildResumeCard({
			note: note([{ kind: "doing", text: "old work" }]),
			diff: null,
		});
		expect(card!.narrative[0]!.refs).toEqual(["legacy:doing"]);
	});

	test("dismissed card is not injected", () => {
		const card = buildResumeCard({
			note: note([{ kind: "doing", text: "work", refs: ["message:m-1"] }]),
			diff: null,
			dismissed: true,
		});
		expect(card!.dismissed).toBe(true);
		expect(card!.inject).toBe(false);
		expect(shouldInjectResumeCard(card)).toBe(false);
	});
});

describe("isResumeCardDismissed", () => {
	test("a dismiss after leave suppresses inject until the next leave", () => {
		const events = [
			{
				type: "thread.left",
				id: "e-leave",
				eventSeq: 10,
				payload: { threadId: "t-1" },
			},
			{
				type: "thread.resume_action",
				id: "e-dismiss",
				eventSeq: 11,
				payload: { threadId: "t-1", action: "resume_card_dismissed" },
			},
		];
		expect(isResumeCardDismissed(events, "t-1", "e-leave")).toBe(true);
	});

	test("a newer leave reopens the card", () => {
		const events = [
			{
				type: "thread.left",
				id: "e-leave-1",
				eventSeq: 10,
				payload: { threadId: "t-1" },
			},
			{
				type: "thread.resume_action",
				eventSeq: 11,
				payload: { threadId: "t-1", action: "resume_card_dismissed" },
			},
			{
				type: "thread.left",
				id: "e-leave-2",
				eventSeq: 20,
				payload: { threadId: "t-1" },
			},
		];
		expect(isResumeCardDismissed(events, "t-1", "e-leave-2")).toBe(false);
	});
});

describe("extractPaths", () => {
	test("pulls repo-relative files out of shifted / next prose", () => {
		expect(extractPaths("edit(src/auth.ts) and src/session.ts")).toEqual([
			"src/auth.ts",
			"src/session.ts",
		]);
	});
});
