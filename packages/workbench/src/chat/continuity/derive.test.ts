import { describe, expect, test } from "bun:test";
import { deriveSessionContinuity } from "./derive";
import type { ContinuityFacts, ContinuityInterruption } from "./types";

/**
 * 阶段三（TF-0330 / TF-0331）的判定表。
 *
 * 这里断言的是**事实允许的结论**：用户主动终止的那一轮不是待办；联合判读
 * 只依赖已有的两维事实（断点 / 积压），不合成单一分数、也不新增采集。
 */

const NOW = "2026-11-02T00:00:00.000Z";

function facts(overrides: Partial<ContinuityFacts> = {}): ContinuityFacts {
	return {
		threadId: "t-1",
		title: "阶段三",
		archived: false,
		createdAt: "2026-11-01T00:00:00.000Z",
		lane: "claude",
		providerSessionId: "session-1",
		resumable: true,
		lineage: { forkedFrom: null, promotedAs: null, adoptedSnapshot: null },
		status: "idle",
		messages: {
			total: 1,
			assistant: 0,
			lastAt: "2026-11-01T00:10:00.000Z",
			lastRole: "user",
		},
		interruptions: [],
		cancellations: [],
		pendingNotices: 0,
		pendingPaths: [],
		deliveredNotices: 0,
		now: NOW,
		...overrides,
	};
}

function interrupted(
	overrides: Partial<ContinuityInterruption> = {},
): ContinuityInterruption {
	return {
		at: "2026-11-01T00:12:00.000Z",
		eventId: "e-in",
		messageCount: 1,
		reason: "host-restarted",
		recovered: false,
		userStopped: false,
		...overrides,
	};
}

describe("TF-0330 中断原因：用户主动终止不是待办", () => {
	test("userStopped 的中断不进 because，但记录留在 cancellations 里", () => {
		const row = deriveSessionContinuity(
			facts({
				interruptions: [interrupted({ userStopped: true })],
				cancellations: [
					{ at: "2026-11-01T00:12:01.000Z", eventId: "e-cx", messageCount: 1 },
				],
			}),
		);
		// 人自己按了停：不是需要别人看一眼的断点
		expect(row.state).toBe("intact");
		expect(row.because).toEqual([]);
		// 记录仍然可核对
		expect(row.turns.cancellations).toHaveLength(1);
		expect(row.refs).toContain("e-in");
	});

	test("原因只有生产者写入的取值：host-restarted 或 unknown，不就近归类", () => {
		const unknown = deriveSessionContinuity(
			facts({ interruptions: [interrupted({ reason: "unknown" })] }),
		);
		expect(unknown.because[0]).toContain("unknown");
		const restarted = deriveSessionContinuity(
			facts({ interruptions: [interrupted({ reason: "host-restarted" })] }),
		);
		expect(restarted.because[0]).toContain("host-restarted");
	});

	test("中断之后有助手回复，仍算恢复（与阶段一一致）", () => {
		const row = deriveSessionContinuity(
			facts({
				messages: {
					total: 2,
					assistant: 1,
					lastAt: "2026-11-01T00:20:00.000Z",
					lastRole: "assistant",
				},
				interruptions: [interrupted({ recovered: true })],
			}),
		);
		expect(row.state).toBe("intact");
	});

	test("用户终止后没有恢复，末条是人类消息也不重复报一条", () => {
		const row = deriveSessionContinuity(
			facts({
				interruptions: [interrupted({ userStopped: true })],
				cancellations: [
					{ at: "2026-11-01T00:13:00.000Z", eventId: "e-cx", messageCount: 1 },
				],
			}),
		);
		// 未回复的人类消息若无未恢复中断解释它，本来会进 because；这里中断在，
		// 只是被 userStopped 排除——所以不该再退回「没有助手回复」这一条。
		expect(row.because).toEqual([]);
		expect(row.state).toBe("intact");
	});
});

describe("TF-0334 每一类 unknown 都可回指字段或事件", () => {
	test("缺 provider 会话 id：指针落到该车道的具体字段（claude / codex）", () => {
		const claude = deriveSessionContinuity(
			facts({ providerSessionId: null, resumable: false }),
		);
		expect(claude.unknowns).toHaveLength(1);
		expect(claude.unknowns[0]!.pointer).toBe(
			"meta.claudeSessionId / meta.hasResumableSession",
		);

		const codex = deriveSessionContinuity(
			facts({
				lane: "codex",
				providerSessionId: null,
				resumable: false,
			}),
		);
		expect(codex.unknowns.map((u) => u.pointer)).toEqual([
			"meta.codexSessionId / meta.hasResumableSession",
		]);
	});

	test("status 仍是 running：指针指向 meta.status", () => {
		const row = deriveSessionContinuity(facts({ status: "running" }));
		expect(row.unknowns.map((u) => u.pointer)).toContain("meta.status");
	});

	test("旧中断事件没有条数：指针指向该事件自身（没有 id 时指向事件类型）", () => {
		const withId = deriveSessionContinuity(
			facts({
				messages: {
					total: 2,
					assistant: 1,
					lastAt: "2026-11-01T00:10:00.000Z",
					lastRole: "assistant",
				},
				interruptions: [interrupted({ messageCount: null })],
			}),
		);
		const withIdUnknown = withId.unknowns.find((u) =>
			u.text.includes("消息条数"),
		);
		expect(withIdUnknown?.pointer).toBe("event:e-in");

		const noId = deriveSessionContinuity(
			facts({
				messages: {
					total: 2,
					assistant: 1,
					lastAt: "2026-11-01T00:10:00.000Z",
					lastRole: "assistant",
				},
				interruptions: [interrupted({ messageCount: null, eventId: null })],
			}),
		);
		const noIdUnknown = noId.unknowns.find((u) => u.text.includes("消息条数"));
		expect(noIdUnknown?.pointer).toBe("eventType:thread.turn_interrupted");
	});

	test("HTTP 车道无 provider 会话 id 不产生 unknown（它本就没有上游会话）", () => {
		const row = deriveSessionContinuity(
			facts({
				lane: "openai-chat",
				providerSessionId: null,
				resumable: false,
			}),
		);
		expect(row.unknowns).toEqual([]);
	});

	test("每条 unknown 都能渲染成带指针的一行（CLI / MCP 共用）", async () => {
		const { unknownLine } = await import("./types");
		const row = deriveSessionContinuity(facts({ status: "running" }));
		expect(unknownLine(row.unknowns[0]!)).toContain("可核对：meta.status");
	});
});

describe("TF-0331 断点 × 积压的联合判读", () => {
	test("两者都有 → break-first", () => {
		const row = deriveSessionContinuity(
			facts({
				interruptions: [interrupted()],
				pendingNotices: 1,
				pendingPaths: ["src/a.ts"],
			}),
		);
		expect(row.priority).toBe("break-first");
		// 两个维度各自可核对，未合并
		expect(row.delivery.pendingNotices).toBe(1);
		expect(row.because.length).toBeGreaterThan(0);
	});

	test("仅断点 → break-first", () => {
		const row = deriveSessionContinuity(
			facts({ interruptions: [interrupted()] }),
		);
		expect(row.priority).toBe("break-first");
	});

	test("仅积压 → backlog-only（末条已由助手收尾，故不是断点）", () => {
		const row = deriveSessionContinuity(
			facts({
				messages: {
					total: 2,
					assistant: 1,
					lastAt: "2026-11-01T00:10:00.000Z",
					lastRole: "assistant",
				},
				pendingNotices: 1,
				pendingPaths: ["src/a.ts"],
			}),
		);
		expect(row.priority).toBe("backlog-only");
		// 积压不改 state：它仍是「无待办观察」
		expect(row.state).toBe("intact");
	});

	test("两者都没有 → neither", () => {
		const row = deriveSessionContinuity(
			facts({
				messages: {
					total: 2,
					assistant: 1,
					lastAt: "2026-11-01T00:10:00.000Z",
					lastRole: "assistant",
				},
			}),
		);
		expect(row.priority).toBe("neither");
	});

	test("用户主动停的那一轮不算断点，只剩积压 → backlog-only", () => {
		const row = deriveSessionContinuity(
			facts({
				messages: {
					total: 2,
					assistant: 1,
					lastAt: "2026-11-01T00:10:00.000Z",
					lastRole: "assistant",
				},
				interruptions: [interrupted({ userStopped: true })],
				cancellations: [
					{ at: "2026-11-01T00:12:01.000Z", eventId: "e-cx", messageCount: 1 },
				],
				pendingNotices: 1,
				pendingPaths: ["src/a.ts"],
			}),
		);
		expect(row.priority).toBe("backlog-only");
	});

	test("汇总里的两维计数与逐行判读一致", async () => {
		const { summarizeContinuity } = await import("./derive");
		const settled = {
			total: 2,
			assistant: 1,
			lastAt: "2026-11-01T00:10:00.000Z",
			lastRole: "assistant" as const,
		};
		const rows = [
			deriveSessionContinuity(facts({ interruptions: [interrupted()] })),
			deriveSessionContinuity(
				facts({
					messages: settled,
					pendingNotices: 1,
					pendingPaths: ["src/a.ts"],
				}),
			),
			deriveSessionContinuity(
				facts({
					messages: {
						total: 2,
						assistant: 1,
						lastAt: "2026-11-01T00:10:00.000Z",
						lastRole: "assistant",
					},
				}),
			),
		];
		const summary = summarizeContinuity(rows);
		expect(summary.breakFirst).toBe(1);
		expect(summary.backlogOnly).toBe(1);
		expect(summary.neither).toBe(1);
		expect(summary.breakFirst + summary.backlogOnly + summary.neither).toBe(
			summary.total,
		);
	});
});
