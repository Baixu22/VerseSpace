import { describe, expect, test } from "bun:test";
import type { Blackboard } from "../blackboard";
import type { LiveCodexSession } from "./codex-session";
import { resetCodexThreadToIdle } from "./codex-session";
import { runCodexTurn } from "./codex-turn";
import type { ThreadContext } from "./thread-context";
import type { ThreadMeta } from "./thread-types";

/**
 * The codex lane resets the durable thread to `idle` on both of its exit
 * paths. If that WRITE fails and is swallowed, the thread stays
 * `status: "running"` forever and every surface keeps showing the busy
 * indicator with no turn behind it. The claude lane reports exactly this
 * failure (`thread-run.ts`: "线程永远停在 running"); these tests pin the codex
 * lane to the same standard, so the two lanes cannot disagree about whether it
 * is worth reporting.
 */

function runningMeta(id = "t-1"): ThreadMeta {
	return {
		id,
		title: "codex 对话",
		createdAt: new Date().toISOString(),
		claudeSessionId: id,
		status: "running",
		permissionMode: "default",
	};
}

function captureErrors(run: () => Promise<void>): Promise<unknown[][]> {
	return (async () => {
		const errors: unknown[][] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => void errors.push(args);
		try {
			await run();
		} finally {
			console.error = original;
		}
		return errors;
	})();
}

/** A store whose reads work and whose writes always fail. */
function failingWriteStore(id = "t-1") {
	return {
		get: async (threadId: string): Promise<ThreadMeta> => ({
			...runningMeta(id),
			id: threadId,
		}),
		saveMeta: async (meta: ThreadMeta): Promise<void> => {
			throw new Error(`磁盘写入失败：${meta.id}`);
		},
	};
}

describe("codex 车道的状态复位失败必须可见", () => {
	test("a failed reset write is reported, not swallowed", async () => {
		const errors = await captureErrors(() =>
			resetCodexThreadToIdle(failingWriteStore(), "t-1"),
		);
		const reported = errors.find((args) => String(args[0]).includes("t-1"));
		expect(reported).toBeDefined();
		expect(String(reported?.[0])).toContain("running");
		expect((reported?.[1] as Error).message).toContain("磁盘写入失败");
	});

	test("a successful reset still returns the thread to idle", async () => {
		const meta = runningMeta();
		await resetCodexThreadToIdle(
			{
				get: async (): Promise<ThreadMeta> => meta,
				saveMeta: async (next: ThreadMeta): Promise<void> => {
					meta.status = next.status;
				},
			},
			meta.id,
		);
		expect(meta.status).toBe("idle");
	});

	test("a turn that never got a codex thread id reports its reset failure", async () => {
		const meta = runningMeta();
		// `run()` marked the thread running; the app-server never minted a
		// thread id, so the turn returns early and must reset the meta.
		const session: LiveCodexSession = {
			server: {} as LiveCodexSession["server"],
			codexThreadId: null,
			stderr: "",
		};
		const context = {
			bb: {} as Blackboard,
			store: failingWriteStore(),
			running: new Map(),
			live: new Map(),
			liveCodex: new Map([[meta.id, session]]),
			observingInheritance: new Set<string>(),
			lineRouters: new Map(),
			pendingVariants: new Map(),
		} as unknown as ThreadContext;

		const emitted: string[] = [];
		const errors = await captureErrors(async () => {
			await runCodexTurn(
				context,
				meta.id,
				meta,
				"你好",
				(event) => {
					if (event.type === "error") emitted.push(event.message);
				},
				{ messageId: "m-1" },
			);
		});

		expect(emitted).toEqual(["codex 线程未能建立"]);
		expect(
			errors.some((args) => String(args[0]).includes("无法把状态复位为 idle")),
		).toBe(true);
	});
});
