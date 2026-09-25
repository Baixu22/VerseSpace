import { describe, expect, test } from "bun:test";
import { reportLiveness } from "./claude-session";
import type { ThreadContext } from "./thread-context";

// TF-0269 (OPEN-8)：liveness 判定的**唯一持久记录**就是 agent_liveness 事件。
// 它以前写作裸的 `.catch(() => {})`——写失败时判定只在当前回合的错误里出现一次，
// 事件日志里什么都不留，于是「agent 静默挂死过」这件事在持久面上消失了。
// 这里直接驱动那条失败分支，不需要真的起一个 claude 会话。
describe("agent_liveness 事件写入失败必须可见（TF-0269）", () => {
	test("append 抛错时点名，且不把异常抛回 liveness 回调", async () => {
		const originalError = console.error;
		const originalWarn = console.warn;
		const errors: string[] = [];
		console.error = (...args: unknown[]) => {
			errors.push(args.map((a) => String(a)).join(" "));
		};
		console.warn = () => {};
		const context = {
			bb: {
				events: {
					append: async () => {
						throw new Error("事件日志不可写");
					},
				},
			},
			live: new Map(),
		} as unknown as ThreadContext;
		try {
			// `stalled` 是副作用最小的判定：写完事件就 warn 并返回，不走到
			// turn 的错误分支，所以这条用例只测「写失败可见」这一件事。
			await reportLiveness(context, "t-1", {
				kind: "stalled",
				silentMs: 46_000,
				lastEventAt: null,
			});
			expect(errors.join("\n")).toContain("agent_liveness 事件写入失败");
			expect(errors.join("\n")).toContain("事件日志不可写");
		} finally {
			console.error = originalError;
			console.warn = originalWarn;
		}
	});
});
