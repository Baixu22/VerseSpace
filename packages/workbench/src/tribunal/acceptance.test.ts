import { describe, expect, test } from "bun:test";
import { emptyUsage } from "../agents/usage";
import { emptyLaneMetrics, foldUsage } from "../blackboard/metrics";
import { admitDispatch, explainWip, observeFlow } from "../scheduler/wip";
import { makeTempWorkbench } from "../test/fixtures";
import type { TribunalCandidate, TribunalEnvelope } from "../types/tribunal";
import { envelopes } from "./envelopes";
import {
	CRITICAL_SHARE_LIMIT,
	distributionHealthy,
	KIND_PROFILES,
	priorityOf,
	SOFT_THRESHOLD,
	scoreOf,
	TARGET_SHARES,
} from "./kinds";
import { RATE_LIMIT_PER_HOUR } from "./queue";

/** End of the synthetic day — stats() is evaluated here. */
const NOW = Date.parse("2026-08-31T18:00:00.000Z");

function atHoursAgo(hours: number, extraMinutes = 0): string {
	return new Date(
		NOW - hours * 3_600_000 - extraMinutes * 60_000,
	).toISOString();
}

function offer(
	envelope: TribunalEnvelope,
	hoursAgo: number,
	extra: Partial<TribunalCandidate> = {},
): TribunalCandidate {
	return { ...envelope, at: atHoursAgo(hoursAgo), ...extra };
}

describe("kind baselines land in the intended bands", () => {
	function band(kind: keyof typeof KIND_PROFILES): string {
		const profile = KIND_PROFILES[kind];
		const score = scoreOf(profile.severity, profile.urgencyMinutes);
		if (score < SOFT_THRESHOLD) {
			return "suppressed";
		}
		return priorityOf(score);
	}

	test("capacity signals stay below the floor; criticals are never a baseline", () => {
		expect(band("concurrency_cap")).toBe("suppressed");
		expect(band("dispatch_suggestion")).toBe("suppressed");
		expect(band("workspot_blocked")).toBe("high");
		expect(band("dependency_missing")).toBe("high");
		expect(band("metric_suspend")).toBe("high");
		// issue #6 item 12：这两条是「已经发生的管道故障」，要推给人而不是
		// 沉在 pull-only 里——但也不能是 critical（critical 只留给升级通道）。
		expect(band("dispatch_failed")).toBe("high");
		expect(band("agent_crashloop")).toBe("high");
		expect(band("dependency_dead")).toBe("medium");
		expect(band("checkpoint_needs_review")).toBe("low");
		expect(band("metric_tool_bloat")).toBe("low");
		for (const kind of Object.keys(KIND_PROFILES) as Array<
			keyof typeof KIND_PROFILES
		>) {
			expect(band(kind)).not.toBe("critical");
		}
	});
});

describe("R3 measured acceptance (TF-0080 / 81 / 82)", () => {
	test("a realistic 24h stream produces the milestone numbers", async () => {
		const { bb, cleanup } = await makeTempWorkbench();
		try {
			const stream: TribunalCandidate[] = [
				offer(
					envelopes.blockedWorkspot("ws-auth", "g-auth", "stale_done"),
					23,
					{ evidence: { paths: ["src/auth/tokens.ts"] } },
				),
				offer(envelopes.blockedWorkspot("ws-a", "g-1", "stale_done"), 22),
				offer(envelopes.missingDependency("g-new", ["g-ghost"]), 21),
				offer(envelopes.metricSuspend("ws-stuck", 2), 20),
				offer(
					envelopes.deadDependency("g-down", "ready", [
						{ id: "g-dead", status: "stale_done" },
					]),
					19,
				),
				offer(
					envelopes.deadDependency("g-other", "planned", [
						{ id: "g-old", status: "cancelled" },
					]),
					17,
				),
				offer(envelopes.metricCacheMiss("ws-a", 0.18), 16),
				offer(envelopes.metricCacheMiss("ws-b", 0.22), 15),
				{
					// 历史样例曾用 premise_invalidated——该 kind 已删（2026-09-13：
					// 零生产者死基线），换用真实生产的 metric_tool_bloat。
					kind: "metric_tool_bloat",
					subject: "ws-a",
					causeKey: "premise:ws-a:src/lib/api.ts",
					action: {
						label: "重读 src/lib/api.ts 再继续",
						command: "workbench premises pending",
					},
					sbar: {
						situation: "工位 ws-a 的前提 src/lib/api.ts 已失效",
						background: "文件在施工期间被别人改过",
						assessment: "继续按旧前提写会把接口写到漂移后的形状上",
						recommendation: "停下来重读该文件，确认新契约后再继续",
					},
					at: atHoursAgo(14),
				},
				offer(envelopes.checkpointAwaitingReview("cp-1"), 13),
				offer(envelopes.checkpointAwaitingReview("cp-2"), 12),
				offer(envelopes.checkpointAwaitingReview("cp-3"), 11),
				offer(envelopes.checkpointWithoutPolicy("cp-draft", "ws-a"), 10),
				offer(envelopes.checkpointWithoutPolicy("cp-notes"), 9),
				offer(envelopes.staleQueueEntries(["g-stale"]), 8),
				offer(envelopes.noIdleWorkspot(4), 7),
				offer(envelopes.metricToolBloat("ws-a", 0.62), 6),
				offer(envelopes.metricToolBloat("ws-b", 0.55), 5),
			];

			// one dead dependency interrupting 30 sessions folds into the first
			for (let i = 0; i < 29; i++) {
				stream.push(
					offer(
						envelopes.deadDependency("g-down", "ready", [
							{ id: "g-dead", status: "stale_done" },
						]),
						19,
						{
							subject: `session-${i}`,
							detail: `会话 ${i} 被同一个失效依赖打断`,
							at: atHoursAgo(19, -i),
						},
					),
				);
			}

			// capacity noise: the floor must eat these or the rate blows up
			for (let i = 0; i < 12; i++) {
				stream.push(offer(envelopes.concurrencyCap(2, 3 + i), 18 - i * 0.5));
			}
			for (let i = 0; i < 8; i++) {
				stream.push(
					offer(envelopes.dispatchSuggestion(`g-ready-${i}`, "ws-idle"), 4),
				);
			}

			let admitted = 0;
			let folded = 0;
			let suppressed = 0;
			for (const candidate of stream) {
				const result = await bb.tribunal.submit(candidate);
				if (result.admitted) {
					admitted += 1;
					if (result.folded) {
						folded += 1;
					}
				} else {
					suppressed += 1;
				}
			}

			const items = await bb.tribunal.list();
			const stats = await bb.tribunal.stats(NOW);
			const distribution = await bb.tribunal.distribution(NOW);

			// measured numbers — this is the milestone, not the unit tests
			expect(stats.ratePerHour).toBeLessThanOrEqual(RATE_LIMIT_PER_HOUR);
			expect(stats.flood).toBe(false);
			expect(stats.criticalShare).toBeLessThanOrEqual(CRITICAL_SHARE_LIMIT);
			expect(stats.rationalizationOk).toBe(true);
			expect(stats.distributionOk).toBe(true);
			expect(
				distributionHealthy({
					critical: distribution.critical,
					high: distribution.high,
					medium: distribution.medium,
					low: distribution.low,
				}),
			).toBe(true);

			expect(folded).toBe(29);
			expect(items.length).toBe(admitted - folded);
			expect(suppressed).toBe(20);
			expect(distribution.total).toBe(items.length);

			for (const item of items) {
				expect(item.action.label.trim().length).toBeGreaterThan(0);
				expect(/[?？]$/.test(item.sbar.recommendation.trim())).toBe(false);
				expect(typeof item.push).toBe("boolean");
				expect("alarmLevel" in item).toBe(false);
			}

			const pushable = await bb.tribunal.pushable();
			expect(pushable.every((item) => item.push)).toBe(true);
			expect(pushable.length).toBeLessThan(items.length);

			// leave the actual mix in the assertion message if it ever drifts
			expect({
				ratePerHour: Number(stats.ratePerHour.toFixed(3)),
				flood: stats.flood,
				criticalShare: Number(stats.criticalShare.toFixed(3)),
				distribution: {
					critical: distribution.critical,
					high: distribution.high,
					medium: distribution.medium,
					low: distribution.low,
					total: distribution.total,
				},
				targets: TARGET_SHARES,
			}).toMatchObject({
				flood: false,
			});
		} finally {
			await cleanup();
		}
	});
});

describe("R3 measured acceptance (TF-0083 / 84)", () => {
	test("WIP is a derived sentence, and a full pool refuses with the drum's numbers", async () => {
		const { bb, cleanup } = await makeTempWorkbench();
		try {
			for (const [i, minutes] of [40, 70, 100].entries()) {
				await bb.events.append({
					timestamp: new Date(NOW - (200 - minutes) * 60_000).toISOString(),
					source: "test",
					type: "goal_dispatched",
					payload: { goalId: `g-${i}` },
				});
				await bb.events.append({
					timestamp: new Date(NOW - minutes * 60_000).toISOString(),
					source: "test",
					type: "goal_status",
					payload: { goalId: `g-${i}`, to: "done" },
				});
			}
			await bb.state.workspots.save({
				id: "ws-a",
				branch: "ws/ws-a",
				worktreePath: "worktrees/ws-a",
				primaryTask: "g-live-a",
				binding: "primary",
				status: "active",
				contextNeeds: { decisions: [], interfaces: [] },
			});
			await bb.state.workspots.save({
				id: "ws-b",
				branch: "ws/ws-b",
				worktreePath: "worktrees/ws-b",
				primaryTask: "g-live-b",
				binding: "primary",
				status: "active",
				contextNeeds: { decisions: [], interfaces: [] },
			});
			const flow = await observeFlow(bb, NOW);
			expect(flow.basis).toBe("little-law");
			expect(explainWip(flow)).toContain("Little 定律");
			expect(explainWip(flow)).toContain("推导");
			expect(flow.tokensFree).toBe(0);
			const refused = await admitDispatch(bb, {}, NOW);
			expect(refused.allowed).toBe(false);
			expect(refused.reason).toContain("复核");
			expect(refused.reason).toContain("--force");
		} finally {
			await cleanup();
		}
	});

	test("each lane shows three numbers and the board shows one shared backlog", async () => {
		const { bb, cleanup } = await makeTempWorkbench();
		try {
			let lane = emptyLaneMetrics("ws-a");
			lane = foldUsage(lane, {
				...emptyUsage(),
				inputTokens: 100,
				outputTokens: 20,
				cacheCreationTokens: 400,
			});
			lane = foldUsage(lane, {
				...emptyUsage(),
				inputTokens: 80,
				outputTokens: 15,
				cacheReadTokens: 900,
			});
			lane = foldUsage(lane, { ...emptyUsage(), compaction: true });
			await bb.metrics.save("ws-a", lane);

			const goal = await bb.goals.add({ title: "待复核" });
			await bb.checkpoints.save(
				{
					id: "cp-review",
					goal: goal.id,
					workspot: "ws-a",
					timestamp: new Date(NOW).toISOString(),
					assertion: "待复核",
					lifecycle: "awaiting_review",
					artifacts: [],
					unblocks: [],
					blackboardEffects: { publish: [], update: [] },
				},
				"staging",
			);

			const shown = (await bb.metrics.list())[0];
			const flow = await observeFlow(bb, NOW);
			expect(shown?.absoluteTokens).toBeGreaterThan(0);
			expect(shown?.cacheHitRate).toBeGreaterThan(0);
			expect(shown?.compactions).toBe(1);
			expect(flow.unreviewedBacklog).toBe(1);
		} finally {
			await cleanup();
		}
	});
});
