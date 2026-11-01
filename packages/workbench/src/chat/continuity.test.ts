import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chatContext } from "../test/chat-context";
import { makeTempWorkbench } from "../test/fixtures";
import { deriveSessionContinuity } from "./continuity/derive";
import {
	readAllSessionContinuity,
	readSessionContinuity,
} from "./continuity/read";
import type { ContinuityFacts } from "./continuity/types";
import { ThreadRepository } from "./thread-repository";
import { ChatThreads } from "./threads";

const NOW = new Date("2026-11-01T00:00:00.000Z");

function facts(overrides: Partial<ContinuityFacts> = {}): ContinuityFacts {
	return {
		threadId: "t-1",
		title: "会话延续性",
		archived: false,
		createdAt: "2026-10-31T00:00:00.000Z",
		lane: "claude",
		providerSessionId: "session-1",
		resumable: true,
		lineage: { forkedFrom: null, promotedAs: null, adoptedSnapshot: null },
		status: "idle",
		messages: {
			total: 2,
			assistant: 1,
			lastAt: "2026-10-31T00:10:00.000Z",
			lastRole: "assistant",
		},
		interruptions: [],
		cancellations: [],
		pendingNotices: 0,
		pendingPaths: [],
		deliveredNotices: 0,
		now: NOW.toISOString(),
		...overrides,
	};
}

describe("deriveSessionContinuity", () => {
	test("一条回合已收尾、没有待办通知时是 intact", () => {
		const row = deriveSessionContinuity(facts());
		expect(row.state).toBe("intact");
		expect(row.because).toEqual([]);
		expect(row.unknowns).toEqual([]);
		expect(row.turns.completed).toBe(1);
		expect(row.identity.providerSessionId).toBe("session-1");
	});

	test("末条是人类消息且没有回复时进入 review，并说明原因", () => {
		const row = deriveSessionContinuity(
			facts({
				messages: {
					total: 1,
					assistant: 0,
					lastAt: "2026-10-31T00:10:00.000Z",
					lastRole: "user",
				},
			}),
		);
		expect(row.state).toBe("review");
		expect(row.turns.open).toBe(true);
		expect(row.because.join(" ")).toContain("没有助手回复");
	});

	test("未恢复的中断进入 review，恢复过的只留记录不报待办", () => {
		const interrupted = deriveSessionContinuity(
			facts({
				messages: {
					total: 1,
					assistant: 0,
					lastAt: "2026-10-31T00:10:00.000Z",
					lastRole: "user",
				},
				interruptions: [
					{
						at: "2026-10-31T00:12:00.000Z",
						eventId: "e-1",
						messageCount: 1,
						reason: "host-restarted",
						recovered: false,
						userStopped: false,
					},
				],
			}),
		);
		expect(interrupted.state).toBe("review");
		// 中断行已经解释了「没有回复」，不再重复计一条同义原因
		expect(interrupted.because).toHaveLength(1);
		expect(interrupted.because[0]).toContain("host-restarted");
		expect(interrupted.refs).toEqual(["e-1"]);

		const recovered = deriveSessionContinuity(
			facts({
				interruptions: [
					{
						at: "2026-10-31T00:12:00.000Z",
						eventId: "e-2",
						messageCount: 1,
						reason: "host-restarted",
						recovered: true,
						userStopped: false,
					},
				],
			}),
		);
		expect(recovered.state).toBe("intact");
		expect(recovered.turns.interruptions[0]?.recovered).toBe(true);
	});

	test("未投递的前提通知不并入 state，但如实留在 delivery 里", () => {
		const row = deriveSessionContinuity(
			facts({ pendingNotices: 1, pendingPaths: ["src/a.ts", "src/b.ts"] }),
		);
		// 投递积压是全局事实，不是这条会话断了；混进 review 会让真正的断点看不见
		expect(row.state).toBe("intact");
		expect(row.because).toEqual([]);
		expect(row.delivery.pendingNotices).toBe(1);
		expect(row.delivery.pendingPaths).toEqual(["src/a.ts", "src/b.ts"]);
	});

	test("仍标记 running 时是 unknown，不把沉默读成健康", () => {
		const row = deriveSessionContinuity(facts({ status: "running" }));
		expect(row.state).toBe("unknown");
		// TF-0334：每条缺口都指名字段/事件，不能只说「材料不足」
		expect(row.unknowns.map((u) => u.text).join(" ")).toContain("运行中");
		expect(row.unknowns.map((u) => u.pointer)).toEqual(["meta.status"]);
	});

	test("本地 CLI 车道缺少 provider 会话 id 时是 unknown；HTTP 车道不算缺", () => {
		const missing = deriveSessionContinuity(
			facts({ providerSessionId: null, resumable: false }),
		);
		expect(missing.state).toBe("unknown");
		expect(missing.unknowns.map((u) => u.text).join(" ")).toContain(
			"provider 会话 id",
		);
		// 指针落到车道的具体字段上，而不是一句笼统的「缺 id」
		expect(missing.unknowns[0]?.pointer).toContain("meta.claudeSessionId");
		expect(missing.unknowns[0]?.pointer).toContain("hasResumableSession");

		const http = deriveSessionContinuity(
			facts({
				lane: "openai-chat",
				providerSessionId: null,
				resumable: false,
			}),
		);
		expect(http.state).toBe("intact");
	});

	test("需要人看的事实优先于材料不足：两者同时存在时 state 是 review", () => {
		const row = deriveSessionContinuity(
			facts({
				status: "running",
				messages: {
					total: 1,
					assistant: 0,
					lastAt: "2026-10-31T00:10:00.000Z",
					lastRole: "user",
				},
			}),
		);
		expect(row.state).toBe("review");
		expect(row.unknowns.length).toBeGreaterThan(0);
	});

	test("新线程没有消息时是 intact，不报未知", () => {
		const row = deriveSessionContinuity(
			facts({
				messages: { total: 0, assistant: 0, lastAt: null, lastRole: null },
			}),
		);
		expect(row.state).toBe("intact");
		expect(row.turns.open).toBe(false);
	});
});

describe("readSessionContinuity", () => {
	test("从三条写者折出同一份读数，并沿用事件身份", async () => {
		const ws = await makeTempWorkbench();
		try {
			const chat = new ChatThreads(ws.bb);
			const thread = await chat.create("延续性现场");
			await ws.bb.events.appendThread("thread.turn_interrupted", {
				threadId: thread.id,
				at: "2026-11-01T00:00:00.000Z",
				atMessageCount: 0,
				reason: "host-restarted",
			});
			const row = await readSessionContinuity(ws.bb, thread.id, NOW);
			expect(row.threadId).toBe(thread.id);
			expect(row.turns.interruptions).toHaveLength(1);
			expect(row.turns.interruptions[0]?.recovered).toBe(false);
			expect(row.state).toBe("review");
			expect(row.refs.length).toBe(1);
			// 新线程还没跑过任何一轮：lane 来自绑定，未运行时没有 provider 会话 id
			expect(row.identity.lane).toBeNull();
			expect(row.readAt).toBe(NOW.toISOString());

			const all = await readAllSessionContinuity(ws.bb, NOW);
			expect(all.rows).toHaveLength(1);
			expect(all.summary.total).toBe(1);
			expect(all.summary.review).toBe(1);
			expect(all.summary.pending).toBe(0);
		} finally {
			await ws.cleanup();
		}
	});

	test("不存在的线程报出线程 id，而不是把 ENOENT 抛给调用者", async () => {
		const ws = await makeTempWorkbench();
		try {
			await expect(
				readSessionContinuity(ws.bb, "no-such-thread", NOW),
			).rejects.toThrow("线程不存在：no-such-thread");
		} finally {
			await ws.cleanup();
		}
	});

	test("启动清扫先落中断观察再复位状态，且可重复调用", async () => {
		const ws = await makeTempWorkbench();
		try {
			const chat = new ChatThreads(ws.bb);
			const thread = await chat.create("被切断的会话");
			const metaFile = join(
				ws.workbenchRoot,
				"threads",
				thread.id,
				"meta.json",
			);
			const meta = JSON.parse(await readFile(metaFile, "utf8")) as {
				status: string;
			};
			meta.status = "running";
			await writeFile(metaFile, JSON.stringify(meta, null, 2), "utf8");

			// 新实例从磁盘读 meta（旧实例的缓存仍是 idle）
			expect(await new ChatThreads(ws.bb).reconcileRunningOnStartup()).toBe(1);
			expect(await new ChatThreads(ws.bb).reconcileRunningOnStartup()).toBe(0);

			const events = await ws.bb.events.all();
			const interruptions = events.filter(
				(event) => event.type === "thread.turn_interrupted",
			);
			expect(interruptions).toHaveLength(1);
			const payload = interruptions[0]?.payload as {
				threadId: string;
				reason: string;
				atMessageCount: number;
			};
			expect(payload.threadId).toBe(thread.id);
			expect(payload.reason).toBe("host-restarted");
			expect(payload.atMessageCount).toBe(0);

			const row = await readSessionContinuity(ws.bb, thread.id, NOW);
			expect(row.state).toBe("review");
			expect(row.because[0]).toContain("host-restarted");
		} finally {
			await ws.cleanup();
		}
	});

	test("TF-0330 现场：用户调 cancel 会落一条终止观察，该轮不再排进待办", async () => {
		const ws = await makeTempWorkbench();
		try {
			const chat = new ChatThreads(ws.bb);
			const thread = await chat.create("用户主动停下的会话");
			const store = new ThreadRepository(ws.bb);
			await store.appendMessage(thread.id, {
				id: "m-1",
				role: "user",
				text: "跑一个很长的东西",
				at: "2026-11-01T00:01:00.000Z",
			});
			// 模拟「有一个在跑的回合」：给 running 放一个可被 abort 的 handle。
			// cancel 走的是同一个代码路径（abort + 落 thread.turn_cancelled）。
			expect(await chat.cancel(thread.id)).toBe(false); // 没有在跑 → 不写观察
			const none = await ws.bb.events.all();
			expect(
				none.filter((e) => e.type === "thread.turn_cancelled"),
			).toHaveLength(0);

			// 真正的在跑回合：把 handle 放进 running 映射（测试用的既有接入点），
			// 再走同一条 cancel 代码路径——abort + 落 thread.turn_cancelled。
			const controller = new AbortController();
			chatContext(chat).running.set(thread.id, controller);
			const cancelled = await chat.cancel(thread.id);
			expect(cancelled).toBe(true);
			expect(controller.signal.aborted).toBe(true);

			const events = await ws.bb.events.all();
			const records = events.filter((e) => e.type === "thread.turn_cancelled");
			expect(records).toHaveLength(1);
			expect(records[0]?.payload).toMatchObject({
				threadId: thread.id,
				source: "user",
				atMessageCount: 1,
			});

			// 回合一收尾就从 running 映射里删除（真实路径里是 turn 的 finally）。
			// 之后再停就没有东西可停：不写第二条观察。
			chatContext(chat).running.delete(thread.id);
			expect(await chat.cancel(thread.id)).toBe(false);
			expect(
				(await ws.bb.events.all()).filter(
					(e) => e.type === "thread.turn_cancelled",
				),
			).toHaveLength(1);

			// 投影：用户主动停的那一轮不是待办。末条是人类消息 + 终止观察落在
			// 它之后 = 「没有回复」是有人主动停的，不是被切断，故不报 review。
			const row = await readSessionContinuity(ws.bb, thread.id, NOW);
			expect(row.turns.cancellations).toHaveLength(1);
			expect(row.because).toEqual([]);
			expect(row.state).toBe("intact");
			expect(row.priority).toBe("neither");
			// 终止记录可核对
			expect(row.refs.some((r) => r.includes("e-"))).toBe(true);

			// 对照：没有终止观察时，同样的末条人类消息仍然是 review（不是被停）。
			const other = await chat.create("被切断的对照");
			await new ThreadRepository(ws.bb).appendMessage(other.id, {
				id: "m-1",
				role: "user",
				text: "问了没答",
				at: "2026-11-01T00:01:00.000Z",
			});
			const brokeRow = await readSessionContinuity(ws.bb, other.id, NOW);
			expect(brokeRow.state).toBe("review");
			expect(brokeRow.priority).toBe("break-first");
		} finally {
			await ws.cleanup();
		}
	});

	test("中断之后有助手消息回答过，就不再需要人处理", async () => {
		const ws = await makeTempWorkbench();
		try {
			const chat = new ChatThreads(ws.bb);
			const thread = await chat.create("恢复过的会话");
			await ws.bb.events.appendThread("thread.turn_interrupted", {
				threadId: thread.id,
				at: "2026-11-01T00:00:00.000Z",
				atMessageCount: 0,
				reason: "host-restarted",
			});
			const store = new ThreadRepository(ws.bb);
			await store.appendMessage(thread.id, {
				id: "m-1",
				role: "user",
				text: "继续",
				at: "2026-11-01T00:01:00.000Z",
			});
			await store.appendMessage(thread.id, {
				id: "m-2",
				role: "assistant",
				text: "接着做完了",
				at: "2026-11-01T00:02:00.000Z",
			});

			const row = await readSessionContinuity(ws.bb, thread.id, NOW);
			expect(row.turns.interruptions[0]?.recovered).toBe(true);
			expect(row.state).toBe("intact");
		} finally {
			await ws.cleanup();
		}
	});
});
