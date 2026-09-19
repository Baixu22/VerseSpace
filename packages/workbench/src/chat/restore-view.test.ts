import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hashPathClaim } from "../blackboard/footprint";
import { makeTempWorkbench, type TempWorkbench } from "../test/fixtures";
import { createUiServer } from "../ui/server";
import { collectRestoreView } from "./restore-view";
import type { ResumeCardView } from "./resume-card";
import { branchResumeFacts } from "./resume-card/branches";
import { collectChatStats } from "./stats";
import { ChatThreads } from "./threads";

async function sourceThread(ws: TempWorkbench, chat: ChatThreads) {
	const source = await chat.create("恢复工作");
	await mkdir(join(ws.projectDir, "src"));
	await writeFile(join(ws.projectDir, "src/a.ts"), "export const a = 1;\n");
	await writeFile(
		join(ws.workbenchRoot, "threads", source.id, "messages.jsonl"),
		`${JSON.stringify({ id: "m-1", role: "user", text: "继续实现", at: new Date().toISOString() })}\n`,
	);
	return source;
}

async function readA(ws: TempWorkbench, writer: string) {
	await ws.bb.sessions.recordActivity(writer, {
		activity: "read-a",
		agent: writer,
		used: [await hashPathClaim(ws.projectDir, "src/a.ts")],
		generated: [],
	});
}

async function writeA(ws: TempWorkbench, writer: string, value: number) {
	await writeFile(
		join(ws.projectDir, "src/a.ts"),
		`export const a = ${value};\n`,
	);
	await ws.bb.sessions.recordActivity(writer, {
		activity: "write-a",
		agent: writer,
		used: [],
		generated: [await hashPathClaim(ws.projectDir, "src/a.ts")],
	});
}

test("R10: the GET route joins branch writes, ledger changes and evidence; dismiss survives the next GET", async () => {
	const ws = await makeTempWorkbench();
	const chat = new ChatThreads(ws.bb);
	const server = await createUiServer(ws.bb, 0);
	try {
		const source = await sourceThread(ws, chat);
		const branch = (await chat.fork(source.id, "m-1")).thread!;
		const empty = (await chat.fork(source.id, "m-1")).thread!;
		const old = (await chat.fork(source.id, "m-1")).thread!;
		await writeA(ws, old.id, 2);
		await readA(ws, source.id);
		await chat.leave(source.id);
		const path = `/api/chat/threads/${source.id}`;
		const request = (suffix = "", method = "GET") =>
			server.handle(
				new Request(`http://127.0.0.1:${server.port}${path}${suffix}`, {
					method,
					headers: { "x-workbench-token": server.authToken },
				}),
			);
		const before = (await request().then((response) => response.json())) as {
			resumeCard: ResumeCardView;
		};
		expect(
			before.resumeCard.facts.filter((row) => row.source === "branch"),
		).toEqual([]);

		await writeA(ws, branch.id, 3);
		await chat.fork(branch.id, "m-1");
		const staleEvent = await ws.bb.events.append({
			timestamp: new Date().toISOString(),
			source: "runtime",
			type: "premise_stale",
			payload: { writer: source.id, stale: [{ path: "src/a.ts" }] },
		});
		const events = await ws.bb.events.all();
		const restored = (await request().then((response) => response.json())) as {
			resumeCard: ResumeCardView;
		};
		const rows = restored.resumeCard.facts.filter(
			(row) => row.source === "branch",
		);
		expect(rows).toHaveLength(1);
		const row = rows[0]!;
		expect(row.annotation?.rule).toBe("R10");
		expect(row.branch).toEqual({
			threadId: branch.id,
			anchorMessageId: "m-1",
			paths: ["src/a.ts"],
			newForks: 1,
		});
		expect(row.refs).toContain(staleEvent.id!);
		const eventIds = new Set(events.map((event) => event.id));
		expect(
			row.refs.every((ref) => eventIds.has(ref.replace(/^footprint:/, ""))),
		).toBe(true);
		expect(row.refs).not.toHaveLength(0);
		expect(JSON.stringify(rows)).not.toContain(empty.id);
		expect(JSON.stringify(rows)).not.toContain(old.id);
		expect(row).not.toHaveProperty("status");
		expect(row).not.toHaveProperty("verdict");
		expect(restored.resumeCard.coverage.text).toContain("1 个已变");
		expect(await ws.bb.events.all()).toEqual(events);

		expect((await request("/resume-note/dismiss", "POST")).ok).toBe(true);
		const dismissed = (await request().then((response) => response.json())) as {
			resumeCard: ResumeCardView;
		};
		expect(
			dismissed.resumeCard.facts.some((fact) => fact.source === "branch"),
		).toBe(true);
		expect(dismissed.resumeCard.dismissed).toBe(true);
		expect(dismissed.resumeCard.inject).toBe(false);
	} finally {
		server.stop(true);
		await ws.cleanup();
	}
});

test("TF-0198 渲染门：≥3 个分支行折叠为一行，溯源与文件事实保留", async () => {
	const ws = await makeTempWorkbench();
	const chat = new ChatThreads(ws.bb);
	try {
		const source = await sourceThread(ws, chat);
		await readA(ws, source.id);
		await chat.leave(source.id);
		const branches = [];
		for (let value = 3; value <= 4; value += 1) {
			const branch = (await chat.fork(source.id, "m-1")).thread!;
			await writeA(ws, branch.id, value);
			branches.push(branch);
		}
		await ws.bb.events.append({
			timestamp: new Date().toISOString(),
			source: "runtime",
			type: "premise_stale",
			payload: { writer: source.id, stale: [{ path: "src/a.ts" }] },
		});
		const branchRows = (view: { resumeCard: ResumeCardView | null }) =>
			view.resumeCard?.facts.filter((row) => row.source === "branch") ?? [];
		let view = await collectRestoreView(ws.bb, chat, source.id);
		expect(branchRows(view)).toHaveLength(2);

		const third = (await chat.fork(source.id, "m-1")).thread!;
		await writeA(ws, third.id, 5);
		branches.push(third);
		view = await collectRestoreView(ws.bb, chat, source.id);
		const merged = branchRows(view);
		expect(merged).toHaveLength(1);
		const row = merged[0]!;
		expect(row.path).toBe("分支 · 3 个分支有动静");
		expect(row.summary).toContain("分支动静已折叠");
		expect(row.annotation?.rule).toBe("R10");
		expect(row.branch).toBeUndefined();
		// 溯源不折叠：每个分支的写集足迹 ref 都在并集里。
		const events = await ws.bb.events.all();
		for (const branch of branches) {
			const footprint = events.find(
				(event) =>
					event.type === "footprint" &&
					(event.payload as { writer?: string }).writer === branch.id,
			);
			expect(footprint?.id).toBeDefined();
			if (footprint?.id) {
				expect(row.refs).toContain(footprint.id);
			}
		}
		// 合并把行数还给文件事实：stale 文件行仍独立渲染。
		expect(
			view.resumeCard?.facts.some((fact) => fact.path === "src/a.ts"),
		).toBe(true);
	} finally {
		await ws.cleanup();
	}
});

test("TF-0198 熔断：dismiss 率超线降 L0 指针行，stats 记录且可恢复", async () => {
	const ws = await makeTempWorkbench();
	const chat = new ChatThreads(ws.bb);
	try {
		const source = await sourceThread(ws, chat);
		const branch = (await chat.fork(source.id, "m-1")).thread!;
		await readA(ws, source.id);
		await chat.leave(source.id);
		await writeA(ws, branch.id, 3);

		// 熔断历史：连续三次恢复只 dismiss（样本量 ≥3 才算证据）。
		for (let i = 0; i < 3; i += 1) {
			await chat.recordRestored(source.id);
			await chat.dismissResumeCard(source.id);
		}
		await chat.recordRestored(source.id);
		let view = await collectRestoreView(ws.bb, chat, source.id);
		const rows = (view.resumeCard?.facts ?? []).filter(
			(row) => row.source === "branch",
		);
		expect(rows).toHaveLength(1);
		const l0 = rows[0]!;
		expect(l0.summary).toContain("写了 1 个你将读的文件");
		expect(l0.summary).not.toContain("账本新增");
		expect(l0.branch?.threadId).toBe(branch.id);
		expect(l0.refs.length).toBeGreaterThan(0);
		// 验收②：stats 有降级记录。
		const stats = await collectChatStats(ws.bb);
		expect(stats.lifecycle.resumeCardCircuit.state).toBe("open");
		expect(stats.lifecycle.resumeCardCircuit.dismissRate).toBe(1);
		expect(stats.lifecycle.resumeCardCircuit.dismissed).toBe(3);

		// 恢复：三次消费后 dismiss 率回到 0.5（开区间不熔断）——L1 回来。
		for (let i = 0; i < 3; i += 1) {
			await chat.recordRestored(source.id);
			await chat.recordResumeAction(source.id, "resume_fact_opened");
		}
		view = await collectRestoreView(ws.bb, chat, source.id);
		const recovered = (view.resumeCard?.facts ?? []).filter(
			(row) => row.source === "branch",
		);
		expect(recovered[0]!.summary).toContain("账本新增");
		const statsAfter = await collectChatStats(ws.bb);
		expect(statsAfter.lifecycle.resumeCardCircuit.state).toBe("closed");
	} finally {
		await ws.cleanup();
	}
});

test("TF-0198 验收①：dismiss 后模型侧注入队列为空", async () => {
	const ws = await makeTempWorkbench();
	const chat = new ChatThreads(ws.bb);
	const server = await createUiServer(ws.bb, 0);
	try {
		const thread = await chat.create("队列撤回");
		expect(await chat.notifySession(thread.id, "前提 A 已失效")).toBe("queued");
		expect(await chat.notifySession(thread.id, "前提 B 已失效")).toBe("queued");
		const noticeFile = join(
			ws.workbenchRoot,
			"threads",
			thread.id,
			"notices.jsonl",
		);
		expect(
			(await readFile(noticeFile, "utf8")).trim().split("\n"),
		).toHaveLength(2);
		const path = `/api/chat/threads/${thread.id}`;
		const request = (suffix = "", method = "GET") =>
			server.handle(
				new Request(`http://127.0.0.1:${server.port}${path}${suffix}`, {
					method,
					headers: { "x-workbench-token": server.authToken },
				}),
			);
		expect((await request("/resume-note/dismiss", "POST")).ok).toBe(true);
		// 路由返回即队列已空：未投递的注入被完全撤回。
		await expect(readFile(noticeFile, "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});
		// dismiss 观测已落事件（notice-outcome 与熔断器共用的那条）。
		const events = await ws.bb.events.all();
		expect(
			events.some(
				(event) =>
					event.type === "thread.resume_action" &&
					(event.payload as { action?: string }).action ===
						"resume_card_dismissed",
			),
		).toBe(true);
		// 队列已空时再 dismiss 不报错。
		expect((await request("/resume-note/dismiss", "POST")).ok).toBe(true);
	} finally {
		server.stop(true);
		await ws.cleanup();
	}
});

test("TF-0199：resume-card/shown 落展示观测，stats 读出展开/点击比例", async () => {
	const ws = await makeTempWorkbench();
	const chat = new ChatThreads(ws.bb);
	const server = await createUiServer(ws.bb, 0);
	try {
		const source = await sourceThread(ws, chat);
		const branch = (await chat.fork(source.id, "m-1")).thread!;
		await readA(ws, source.id);
		await chat.leave(source.id);
		await writeA(ws, branch.id, 3);
		const path = `/api/chat/threads/${source.id}`;
		const request = (suffix: string, method = "GET", body?: unknown) =>
			server.handle(
				new Request(`http://127.0.0.1:${server.port}${path}${suffix}`, {
					method,
					headers: {
						"x-workbench-token": server.authToken,
						...(body ? { "content-type": "application/json" } : {}),
					},
					...(body ? { body: JSON.stringify(body) } : {}),
				}),
			);
		// 恢复 → 渲染出分支行 → UI 上报展示 → 用户展开该行。
		await chat.recordRestored(source.id);
		expect(
			(
				await request("/resume-card/shown", "POST", {
					branchRows: [`branch:${branch.id}`],
				})
			).ok,
		).toBe(true);
		expect(
			(
				await request("/resume-action", "POST", {
					action: "resume_fact_opened",
					label: `branch:${branch.id}`,
				})
			).ok,
		).toBe(true);
		const events = await ws.bb.events.all();
		const shownEvent = events.find(
			(event) => event.type === "thread.resume_card_shown",
		);
		expect(shownEvent).toBeDefined();
		expect(shownEvent!.payload).toMatchObject({
			threadId: source.id,
			branchRows: [`branch:${branch.id}`],
		});
		const expandEvent = events.find(
			(event) =>
				event.type === "thread.resume_action" &&
				(event.payload as { action?: string }).action === "resume_fact_opened",
		);
		expect(expandEvent!.payload).toMatchObject({
			label: `branch:${branch.id}`,
		});
		// 验收判据：展开/被点比例可从 stats --json 读出。
		const stats = await collectChatStats(ws.bb);
		expect(stats.lifecycle.branchEngagement.branchRowsShown).toBe(1);
		expect(stats.lifecycle.branchEngagement.branchRowsEngaged).toBe(1);
		expect(stats.lifecycle.branchEngagement.ratio).toBe(1);
	} finally {
		server.stop(true);
		await ws.cleanup();
	}
});

test("R10: siblings share the source lineage; unrelated writes, missing baselines and unreferenced lineage stay silent", async () => {
	const ws = await makeTempWorkbench();
	const chat = new ChatThreads(ws.bb);
	try {
		const source = await sourceThread(ws, chat);
		const left = (await chat.fork(source.id, "m-1")).thread!;
		const right = (await chat.fork(source.id, "m-1")).thread!;
		const unrelated = await chat.create("其他工作");
		await readA(ws, left.id);
		await chat.leave(left.id);
		await writeA(ws, unrelated.id, 2);
		let view = await collectRestoreView(ws.bb, chat, left.id);
		expect(
			view.resumeCard?.facts.filter((row) => row.source === "branch"),
		).toEqual([]);
		await writeA(ws, right.id, 3);
		view = await collectRestoreView(ws.bb, chat, left.id);
		expect(
			view.resumeCard?.facts.find((row) => row.source === "branch")?.branch
				?.threadId,
		).toBe(right.id);
		const input = {
			bb: ws.bb,
			threadId: left.id,
			threads: await chat.list(),
			events: await ws.bb.events.all(),
			diff: view.readSetDiff,
		};
		expect(
			await branchResumeFacts({
				...input,
				diff: { ...input.diff, baseline: null },
			}),
		).toEqual([]);
		expect(
			await branchResumeFacts({
				...input,
				diff: { ...input.diff, stale: [] },
			}),
		).toEqual([]);
		expect(
			await branchResumeFacts({
				...input,
				events: input.events.filter((event) => event.type !== "thread.forked"),
			}),
		).toEqual([]);
	} finally {
		await ws.cleanup();
	}
});
