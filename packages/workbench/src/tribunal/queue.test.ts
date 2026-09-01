import { describe, expect, test } from "bun:test";
import { makeTempWorkbench } from "../test/fixtures";
import type { TribunalCandidate } from "../types/tribunal";
import { priorityOf, scoreOf } from "./kinds";
import { MAX_SHELVE_MINUTES, MIN_SHELVE_MINUTES } from "./queue";
import { rationalize } from "./rationalize";

function candidate(
	overrides: Partial<TribunalCandidate> = {},
): TribunalCandidate {
	return {
		kind: "workspot_blocked",
		subject: "ws-a",
		causeKey: "workspot_blocked:ws-a",
		action: {
			label: "重新指派工位",
			command: "workbench ws reassign ws-a --task g-2",
		},
		sbar: {
			situation: "工位 ws-a 被阻塞",
			background: "任务 g-1 已进入 stale_done",
			assessment: "工位空转，本轮产出为零",
			recommendation: "把 ws-a 改派到 g-2，或关闭它",
		},
		...overrides,
	};
}

describe("rationalization gate (ISA-18.2)", () => {
	test("an event with no defined action is not an alarm", () => {
		const verdict = rationalize(
			candidate({ action: { label: "  " } }),
			"2026-01-01T00:00:00.000Z",
		);
		expect(verdict.admit).toBe(false);
		if (!verdict.admit) {
			expect(verdict.rule).toBe("actionable");
		}
	});

	test("an event that cannot state its consequence is not an alarm", () => {
		const verdict = rationalize(
			candidate({
				sbar: {
					situation: "工位 ws-a 被阻塞",
					background: "任务 g-1 已失效",
					assessment: "",
					recommendation: "改派",
				},
			}),
		);
		expect(verdict.admit).toBe(false);
		if (!verdict.admit) {
			expect(verdict.rule).toBe("consequence");
		}
	});

	test("an event about nothing in particular is not an alarm", () => {
		const verdict = rationalize(candidate({ subject: "" }));
		expect(verdict.admit).toBe(false);
		if (!verdict.admit) {
			expect(verdict.rule).toBe("relevant");
		}
	});

	test("severity 0 is a state description, not an abnormal event", () => {
		const verdict = rationalize(candidate({ severity: 0 }));
		expect(verdict.admit).toBe(false);
		if (!verdict.admit) {
			expect(verdict.rule).toBe("abnormal");
		}
	});

	test("the ISA-18.2 gate is qualitative — it admits what the floor refuses", () => {
		// concurrency_cap baseline scores ~0.09: a dashboard number, not an
		// alarm. The five qualitative tests all pass (it names a subject, a
		// consequence, and an action), so refusing it is the QUEUE's job.
		const verdict = rationalize(
			candidate({ kind: "concurrency_cap", causeKey: "cap", subject: "ws-a" }),
		);
		expect(verdict.admit).toBe(true);
	});

	test("an isolated event under the soft floor never enters the queue", async () => {
		const { bb, cleanup } = await makeTempWorkbench();
		try {
			const result = await bb.tribunal.submit(
				candidate({
					kind: "concurrency_cap",
					causeKey: "cap",
					subject: "ws-a",
				}),
			);
			expect(result.admitted).toBe(false);
			if (!result.admitted) {
				expect(result.rule).toBe("soft_floor");
				expect(result.reason).toContain("软阈值");
			}
			expect(await bb.tribunal.list()).toHaveLength(0);
		} finally {
			await cleanup();
		}
	});

	test("a twin rides along with a cause already in the queue, under the floor or not", async () => {
		// the whole reason the floor is the queue's job: once a cause is
		// carried, later events of that cause fold instead of being re-judged
		const { bb, cleanup } = await makeTempWorkbench();
		try {
			const first = await bb.tribunal.submit(candidate({ causeKey: "c:1" }));
			expect(first.admitted).toBe(true);
			const twin = await bb.tribunal.submit(
				candidate({
					causeKey: "c:1",
					kind: "concurrency_cap",
					subject: "ws-b",
				}),
			);
			expect(twin.admitted).toBe(true);
			if (twin.admitted) {
				expect(twin.folded).toBe(true);
				expect(twin.item.folded).toHaveLength(1);
			}
			expect(await bb.tribunal.list()).toHaveLength(1);
		} finally {
			await cleanup();
		}
	});

	test("a rationalized event carries its own action and a recommendation", () => {
		const verdict = rationalize(candidate());
		expect(verdict.admit).toBe(true);
		if (verdict.admit) {
			expect(verdict.draft.action.command).toContain("workbench ws reassign");
			expect(verdict.draft.sbar.recommendation).toContain("改派");
			expect(verdict.draft.push).toBe(true);
			expect(verdict.draft.priority).toBe("high");
		}
	});
});

describe("priority is consequence × deadline, not a hand-tuned label", () => {
	test("the same severity grades up as the deadline tightens", () => {
		const slack = priorityOf(scoreOf(0.5, 240));
		const soon = priorityOf(scoreOf(0.5, 5));
		expect(slack).toBe("low");
		expect(soon).toBe("medium");
	});

	test("escalation jumps the score entirely", () => {
		expect(priorityOf(0.1, true)).toBe("critical");
	});
});

describe("NEWS2 single-parameter escalation", () => {
	function escalates(evidence: TribunalCandidate["evidence"]): void {
		const verdict = rationalize(
			candidate({ kind: "premise_invalidated", causeKey: "k1", evidence }),
		);
		expect(verdict.admit).toBe(true);
		if (verdict.admit) {
			expect(verdict.draft.priority).toBe("critical");
			expect(verdict.draft.escalated).toBe(true);
			expect(verdict.draft.push).toBe(true);
			expect(verdict.draft.escalationReason).toBeTruthy();
		}
	}

	test("touching authentication code escalates", () => {
		escalates({ paths: ["src/auth/session.ts"] });
	});

	test("force-push escalates", () => {
		escalates({ commands: ["git push --force origin main"] });
	});

	test("materialized secret material escalates", () => {
		escalates({ content: "-----BEGIN RSA PRIVATE KEY-----" });
	});

	test("ordinary paths do not escalate", () => {
		const verdict = rationalize(
			candidate({ evidence: { paths: ["src/contextgen/render.ts"] } }),
		);
		expect(verdict.admit).toBe(true);
		if (verdict.admit) {
			expect(verdict.draft.escalated).toBe(false);
		}
	});
});

describe("adjudication queue", () => {
	test("one cause interrupting 30 sessions is one item carrying 30", async () => {
		const { bb, cleanup } = await makeTempWorkbench();
		try {
			let last: Awaited<ReturnType<typeof bb.tribunal.submit>> | null = null;
			for (let i = 0; i < 30; i++) {
				last = await bb.tribunal.submit(
					candidate({
						causeKey: "dependency_dead:g-1",
						subject: `ws-${i}`,
						detail: `会话 ${i} 被同一个失效依赖打断`,
					}),
				);
			}
			expect(last?.admitted).toBe(true);
			const open = await bb.tribunal.list();
			expect(open).toHaveLength(1);
			expect(open[0]?.folded).toHaveLength(29);
			expect(open[0]?.subject).toBe("ws-0"); // first cause owns the item
		} finally {
			await cleanup();
		}
	});

	test("a worse twin raises the item, never lowers it", async () => {
		const { bb, cleanup } = await makeTempWorkbench();
		try {
			await bb.tribunal.submit(
				candidate({
					kind: "queue_stale_entries",
					causeKey: "dep:g-1",
					subject: "g-2",
					severity: 0.9,
					urgencyMinutes: 5,
				}),
			);
			const after = await bb.tribunal.submit(
				candidate({
					kind: "queue_stale_entries",
					causeKey: "dep:g-1",
					subject: "g-3",
					severity: 0.35,
					urgencyMinutes: 240,
				}),
			);
			expect(after.admitted).toBe(true);
			if (after.admitted) {
				expect(after.item.severity).toBeCloseTo(0.9, 5);
				expect(after.item.urgencyMinutes).toBe(5);
				expect(after.folded).toBe(true);
			}
		} finally {
			await cleanup();
		}
	});

	test("the same cause after the aggregation window starts a new episode", async () => {
		const { bb, cleanup } = await makeTempWorkbench();
		try {
			await bb.tribunal.submit(candidate({ causeKey: "c:1" }));
			await bb.tribunal.submit(
				candidate({ causeKey: "c:1", subject: "ws-later", at: laterBy(31) }),
			);
			expect(await bb.tribunal.list()).toHaveLength(2);
		} finally {
			await cleanup();
		}
	});

	test("suppression is recorded, not silent", async () => {
		const { bb, cleanup } = await makeTempWorkbench();
		try {
			await bb.tribunal.submit(
				candidate({
					kind: "concurrency_cap",
					causeKey: "cap",
					subject: "ws-a",
				}),
			);
			const events = await bb.events.tail(10);
			expect(events.some((e) => e.type === "tribunal_suppressed")).toBe(true);
			expect(await bb.tribunal.list()).toHaveLength(0);
		} finally {
			await cleanup();
		}
	});

	test("shelving is bounded on both ends", async () => {
		const { bb, cleanup } = await makeTempWorkbench();
		try {
			const submitted = await bb.tribunal.submit(candidate());
			if (!submitted.admitted) throw new Error("expected admission");
			const id = submitted.item.id;

			const tooShort = await bb.tribunal.shelve(id, 1);
			expect(
				minutesBetween(tooShort?.createdAt ?? "", tooShort?.shelvedUntil ?? ""),
			).toBe(MIN_SHELVE_MINUTES);
			const tooLong = await bb.tribunal.shelve(id, 600);
			expect(
				minutesBetween(tooLong?.createdAt ?? "", tooLong?.shelvedUntil ?? ""),
			).toBe(MAX_SHELVE_MINUTES);
			expect(tooLong?.shelveCount).toBe(2); // the deferral KPI
		} finally {
			await cleanup();
		}
	});

	test("a lapsed deferral reopens on its own", async () => {
		const { bb, cleanup } = await makeTempWorkbench();
		try {
			const submitted = await bb.tribunal.submit(candidate());
			if (!submitted.admitted) throw new Error("expected admission");
			const id = submitted.item.id;
			await bb.tribunal.shelve(id, MIN_SHELVE_MINUTES);

			expect((await bb.tribunal.list()).map((i) => i.state)).toEqual([
				"shelved",
			]);
			// read-only views compute expiry without writing, so the panel and
			// the writer agree once the deferral lapses
			const past = Date.now() + (MIN_SHELVE_MINUTES + 1) * 60_000;
			const reopened = await bb.tribunal.expireShelved(past);
			expect(reopened).toBe(1);
			expect((await bb.tribunal.get(id))?.state).toBe("pending");
		} finally {
			await cleanup();
		}
	});

	test("a resolved item leaves the open queue but stays on disk", async () => {
		const { bb, cleanup } = await makeTempWorkbench();
		try {
			const submitted = await bb.tribunal.submit(candidate());
			if (!submitted.admitted) throw new Error("expected admission");
			await bb.tribunal.resolve(submitted.item.id);
			expect(await bb.tribunal.list()).toHaveLength(0);
			expect(await bb.tribunal.list({ includeResolved: true })).toHaveLength(1);
			// re-resolving is a no-op, not an error
			expect(await bb.tribunal.resolve(submitted.item.id)).toBeNull();
		} finally {
			await cleanup();
		}
	});

	test("a quarter criticals means the grading failed", async () => {
		const { bb, cleanup } = await makeTempWorkbench();
		try {
			for (let i = 0; i < 4; i++) {
				await bb.tribunal.submit(
					candidate({
						causeKey: `c:${i}`,
						subject: `s-${i}`,
						evidence: { paths: ["src/auth/tokens.ts"] },
					}),
				);
			}
			const stats = await bb.tribunal.stats();
			expect(stats.criticalShare).toBe(1);
			expect(stats.rationalizationOk).toBe(false);

			await bb.tribunal.resolve((await bb.tribunal.list())[0]!.id);
			const after = await bb.tribunal.stats();
			expect(after.rationalizationOk).toBe(false); // 3 of 3 is still 100%
		} finally {
			await cleanup();
		}
	});

	test("10 events in 10 minutes is a flood, not a queue", async () => {
		const { bb, cleanup } = await makeTempWorkbench();
		try {
			for (let i = 0; i < 9; i++) {
				await bb.tribunal.submit(
					candidate({ causeKey: `c:${i}`, subject: `s-${i}` }),
				);
			}
			expect((await bb.tribunal.stats()).flood).toBe(false);
			await bb.tribunal.submit(candidate({ causeKey: "c:9", subject: "s-9" }));
			const stats = await bb.tribunal.stats();
			expect(stats.flood).toBe(true);
			// flood is instantaneous; the 24h rate is a separate budget
			expect(stats.ratePerHour).toBeLessThan(6);
		} finally {
			await cleanup();
		}
	});

	test("push is binary: only what clears the threshold interrupts", async () => {
		const { bb, cleanup } = await makeTempWorkbench();
		try {
			// soft-summary band: admitted to the queue, never pushed
			await bb.tribunal.submit(
				candidate({
					kind: "checkpoint_needs_review",
					causeKey: "cp:1",
					subject: "cp-1",
				}),
			);
			await bb.tribunal.submit(
				candidate({
					kind: "workspot_blocked",
					causeKey: "ws:1",
					subject: "ws-1",
				}),
			);
			const pushable = await bb.tribunal.pushable();
			expect(pushable).toHaveLength(1);
			expect(pushable[0]?.subject).toBe("ws-1");
			// the soft one is still there for a human who goes looking
			expect(await bb.tribunal.list()).toHaveLength(2);
		} finally {
			await cleanup();
		}
	});
});

function laterBy(minutes: number): string {
	return new Date(Date.now() + minutes * 60_000).toISOString();
}

function minutesBetween(from: string, to: string): number {
	return Math.round((Date.parse(to) - Date.parse(from)) / 60_000);
}
