import { describe, expect, test } from "bun:test";
import { makeTempWorkbench } from "../test/fixtures";

describe("sessions region (R1 writers)", () => {
	test("register / list / get across writer kinds", async () => {
		const { bb, cleanup } = await makeTempWorkbench();
		try {
			await bb.sessions.register("t-uuid-1", "agent", "聊天会话");
			await bb.sessions.register("human", "human", "编辑器");
			await bb.sessions.register("git", "git", "git 变动");
			await bb.sessions.register("ci", "ci", "CI 提交");

			const list = await bb.sessions.list();
			// sorted by id: ci < git < human < t-uuid-1
			expect(list.map((w) => w.kind)).toEqual(["ci", "git", "human", "agent"]);
			const agent = await bb.sessions.get("t-uuid-1");
			expect(agent?.status).toBe("active");

			await bb.sessions.setStatus("t-uuid-1", "idle");
			expect((await bb.sessions.get("t-uuid-1"))?.status).toBe("idle");
		} finally {
			await cleanup();
		}
	});

	test("footprint seq is monotonic and the read-set view folds to last versions", async () => {
		const { bb, cleanup } = await makeTempWorkbench();
		try {
			await bb.sessions.register("t-uuid-1", "agent", "足迹会话");
			await bb.sessions.recordActivity("t-uuid-1", {
				activity: "act-1",
				agent: "t-uuid-1",
				used: [{ path: "src/a.ts", version: "hash-v1" }],
				generated: [],
				facets: { tool: "Read" },
			});
			await bb.sessions.recordActivity("t-uuid-1", {
				activity: "act-2",
				agent: "t-uuid-1",
				used: [],
				generated: [{ path: "src/a.ts", version: "hash-v2" }],
				facets: { tool: "Write" },
			});
			await bb.sessions.recordActivity("t-uuid-1", {
				activity: "act-3",
				agent: "t-uuid-1",
				used: [{ path: "src/b.ts", version: "hash-b" }],
				generated: [],
				facets: { tool: "Read" },
			});

			const lines = await bb.sessions.footprint("t-uuid-1");
			expect(lines.map((l) => l.seq)).toEqual([1, 2, 3]);

			// full fold: the write supersedes the first read of src/a.ts
			const view = await bb.sessions.readSetView("t-uuid-1");
			expect(view.reads.get("src/a.ts")?.version).toBe("hash-v2");
			expect(view.reads.get("src/b.ts")?.version).toBe("hash-b");
			expect(view.writes).toHaveLength(1);

			// time-travel: at seq <= 2 the write has landed; at seq <= 1 not
			const early = await bb.sessions.readSetView("t-uuid-1", 1);
			expect(early.reads.get("src/a.ts")?.version).toBe("hash-v1");
			expect(early.writes).toHaveLength(0);
		} finally {
			await cleanup();
		}
	});

	test("footprint activities are mirrored as PROV events with the shared seq", async () => {
		const { bb, cleanup } = await makeTempWorkbench();
		try {
			await bb.sessions.register("t-uuid-1", "agent", "事件会话");
			await bb.sessions.recordActivity("t-uuid-1", {
				activity: "act-9",
				agent: "t-uuid-1",
				used: [{ path: "src/x.ts", version: null }],
				generated: [],
			});
			const events = await bb.events.query({ type: "footprint" });
			expect(events).toHaveLength(1);
			const payload = events[0]?.payload as {
				writer: string;
				activity: string;
			};
			expect(payload.writer).toBe("t-uuid-1");
			expect(payload.activity).toBe("act-9");
			// the shared monotonic clock lives on every event now
			expect(typeof events[0]?.seq).toBe("number");
		} finally {
			await cleanup();
		}
	});

	test("recentGeneratedPaths returns fresh agent claims for watcher attribution", async () => {
		const { bb, cleanup } = await makeTempWorkbench();
		try {
			await bb.sessions.register("t-agent", "agent", "认领会话");
			await bb.sessions.register("t-human", "human", "人");
			await bb.sessions.recordActivity("t-agent", {
				activity: "act-a",
				agent: "t-agent",
				used: [],
				generated: [{ path: "D:/proj/claimed.ts", version: "h" }],
			});
			await bb.sessions.recordActivity("t-human", {
				activity: "act-h",
				agent: "t-human",
				used: [],
				generated: [{ path: "D:/proj/human.ts", version: "h" }],
			});
			const claimed = await bb.sessions.recentGeneratedPaths(10_000);
			expect(claimed.has("D:/proj/claimed.ts")).toBe(true);
			// human writes are NOT agent claims
			expect(claimed.has("D:/proj/human.ts")).toBe(false);
		} finally {
			await cleanup();
		}
	});
});
