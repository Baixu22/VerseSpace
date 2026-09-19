/**
 * 真进程端到端场景（工程探索样本源，2026-09-06 用户决策）。
 *
 * 参与者全部是真实组件：真 CLI 子进程（`workbench init` / `sessions record` /
 * `premises seal` / `review-seal` / `context` / `stats` / fit-ledger）、真 HTTP
 * 服务（createUiServer 的完整路由面）、真 git 仓库、真文件系统，以及一个以
 * stream-json 协议对话的确定性 agent 进程（scripts/e2e/fake-agent.ts）。
 * 不 import 任何被测库——一切通过公开表面驱动，这是它和单元测试的边界。
 */

import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { verifyCalibration, verifyOptionalLlm } from "./calibration";
import {
	api,
	cliJson,
	type E2EWorkspace,
	git,
	lastEventFor,
	sendTurn,
	startServer,
	waitFor,
} from "./driver";
import { verifyFamilyNotices } from "./family-notice";
import { makeTempWorkspace, seedProject } from "./fixtures";
import { observeRestore, verifyRestoration } from "./restoration";
import { collectRunReport } from "./verification";

export type { E2EWorkspace };
export { makeTempWorkspace };
export type StepRunner = <T>(
	name: string,
	body: () => Promise<T> | T,
) => Promise<T>;

export interface StepReport {
	step: string;
	ok: boolean;
	detail: Record<string, unknown>;
}

export interface E2EReport {
	projectDir: string;
	steps: StepReport[];
	stats: Record<string, unknown> | null;
	ledgerT0: Record<string, unknown> | null;
	sampleWindow: Record<string, unknown> | null;
	ok: boolean;
}

/**
 * 跑完整场景。`label` 只进报告；所有断言失败直接抛错，由调用方决定
 * 是让测试失败（e2e.test.ts）还是记进租户报告（run.ts）。
 */
export async function runE2E(
	ws: E2EWorkspace,
	options: { keepWorkspace?: boolean } = {},
): Promise<E2EReport> {
	const steps: StepReport[] = [];
	const report: E2EReport = {
		projectDir: ws.projectDir,
		steps,
		stats: null,
		ledgerT0: null,
		sampleWindow: null,
		ok: false,
	};
	const step = async <T>(
		name: string,
		body: () => Promise<T> | T,
	): Promise<T> => {
		process.stderr.write(`[e2e] ▶ ${name}\n`);
		try {
			const detail = await body();
			process.stderr.write(`[e2e] ✓ ${name}\n`);
			steps.push({
				step: name,
				ok: true,
				detail: { detail } as Record<string, unknown>,
			});
			return detail;
		} catch (error) {
			process.stderr.write(`[e2e] ✗ ${name}: ${String(error).slice(0, 300)}\n`);
			steps.push({
				step: name,
				ok: false,
				detail: { error: String(error) },
			});
			throw error;
		}
	};

	await step("seed: git 仓库 + workbench init", () => seedProject(ws));
	const server = await step("server: 真进程 ui 服务启动", () =>
		startServer(ws),
	);

	try {
		const thread = await step("S0 建线程", async () => {
			const res = await api(server, "/api/chat/threads", {
				method: "POST",
				body: JSON.stringify({ title: "E2E 集成线程" }),
			});
			const meta = (await res.json()) as { id: string };
			if (!meta.id) throw new Error("create 未返回线程 id");
			return meta;
		});
		const threadId = thread.id;
		await step("S0b 无卡恢复：记录首条消息之前的观测", async () => {
			const view = await observeRestore(server, threadId);
			if (view.resumeCard) throw new Error("空线程不应有恢复卡");
			return { resumeCardVisible: false };
		});

		await step(
			"S1 agent 真进程回合：带 span 读 notes + 写 alpha v2",
			async () => {
				const events = await sendTurn(
					server,
					threadId,
					[
						"请处理以下任务。",
						// span 读：notes.md 之后被 git 在尾部追加时走 L2 抑制路径
						//（文件变了，写者真正读过的行没变）——notified/overlaps 的分母
						// 由此才有真实的形状，而不是退化的 1.0。
						"READSPAN src/notes.md 1 3",
						"WRITE src/alpha.ts",
						'export const alpha = "v2";',
						"__END_WRITE__",
					].join("\n"),
				);
				const types = events.map((e) => e.type);
				for (const expected of ["user", "turn_started", "parts", "done"]) {
					if (!types.includes(expected)) {
						throw new Error(`事件流缺 ${expected}：${types.join(",")}`);
					}
				}
				const visibleText = events.some((event) =>
					event.type === "delta"
						? typeof event.text === "string" && !!event.text
						: event.type === "parts" &&
							Array.isArray(event.parts) &&
							event.parts.some(
								(part) =>
									part.type === "text" &&
									typeof part.text === "string" &&
									!!part.text,
							),
				);
				const done = events.find((event) => event.type === "done");
				const message = done?.message as { text?: string } | undefined;
				if (!visibleText || !message?.text?.trim())
					throw new Error("助手文本未在终态前可见或最终回复为空");
				const onDisk = await readFile(
					join(ws.projectDir, "src", "alpha.ts"),
					"utf8",
				);
				if (!onDisk.includes("v2")) throw new Error("agent 没有真正写盘");
				return { events: types.length, onDisk: "v2" };
			},
		);

		await step("S2 离开线程（leave）", async () => {
			const res = await api(server, `/api/chat/threads/${threadId}/leave`, {
				method: "POST",
			});
			const note = (await res.json()) as { beats?: unknown[] } | null;
			if (!note || !Array.isArray(note.beats) || note.beats.length === 0) {
				throw new Error("leave 未产出恢复笔记");
			}
			return note;
		});

		await verifyOptionalLlm(server, step);

		await step("S3a human 先读文件，再由 git 删除（护城河 B）", async () => {
			// Read while beta.ts exists. Recording it after deletion captures null,
			// so the subsequent deletion can never invalidate that observation.
			const recorded = await cliJson<{ ok?: boolean }>(ws, [
				"sessions",
				"record",
				"--writer",
				"editor-1",
				"--kind",
				"human",
				"--label",
				"编辑器",
				"--activity",
				"manual-save",
				"--used",
				"src/beta.ts",
			]);
			return recorded;
		});

		await step(
			"S3 git 写者并发：真 git 改 alpha、追加 notes、删 beta 并记录",
			async () => {
				await writeFile(
					join(ws.projectDir, "src", "alpha.ts"),
					'export const alpha = "v3 by git";\n',
					"utf8",
				);
				// notes.md 尾部追加落在 span（1-3 行）之外：L2 抑制路径的数据源
				const notes = await readFile(
					join(ws.projectDir, "src", "notes.md"),
					"utf8",
				);
				await writeFile(
					join(ws.projectDir, "src", "notes.md"),
					`${notes}- 集成跑追加的尾部行（span 之外）\n`,
					"utf8",
				);
				// 本机 `git rm <路径>` 会连文件所在的整个目录一起删掉（宿主删除
				// 钩子 + git 2.55.0.windows.3，见 AGENTS.md「Local environment
				// caveats」），src/alpha.ts 与 src/notes.md 会被一并带走，E2E
				// 随后在 S5 因为一个与被测组件无关的原因失败。改成「真 git 只
				// 动索引 + 精确删除那一个文件」：索引侧的结果与 git rm 完全等价。
				await git(ws, ["rm", "-q", "--cached", "src/beta.ts"]);
				await rm(join(ws.projectDir, "src", "beta.ts"), { force: true });
				await git(ws, [
					"-c",
					"user.email=e2e@local",
					"-c",
					"user.name=e2e",
					"add",
					".",
				]);
				await git(ws, [
					"-c",
					"user.email=e2e@local",
					"-c",
					"user.name=e2e",
					"commit",
					"-q",
					"-m",
					"git writer: alpha v3, drop beta",
				]);
				const recorded = await cliJson<{ ok?: boolean; writer?: string }>(ws, [
					"sessions",
					"record",
					"--writer",
					"git-main",
					"--kind",
					"git",
					"--label",
					"git-main",
					"--activity",
					"commit",
					"--generated",
					"src/alpha.ts",
					"--generated",
					"src/beta.ts",
				]);
				return recorded;
			},
		);

		await step("S4 等服务周期任务产出 premise_stale 与通知", async () => {
			// 只认「本线程」的失效事件：pending 里可能躺着前几轮未 ack 的
			// 队列项，而 reconcile 是 15s 一跳，轮内时序不能赌。
			await waitFor(
				"本线程的 premise_stale 事件",
				async () =>
					(await lastEventFor(ws, "premise_stale", threadId)) !== null,
				60_000,
			);
			return "premise_stale 已产出";
		});

		const branches = await verifyRestoration(ws, server, threadId, step);

		await step(
			"S6b 收养：fork → adopt 翻转身份 → revert 复原（TF-0200）",
			async () => {
				// 列表返回完整 ThreadMeta（含 archived/forkOf），是身份翻转的公开断言面
				const list = async () =>
					(await (await api(server, "/api/chat/threads")).json()) as {
						id: string;
						archived?: boolean;
						forkOf?: { sourceThreadId: string };
					}[];
				// 取主线末条消息作锚点，走公开表面做一次追溯式分叉
				const view = (await (
					await api(server, `/api/chat/threads/${threadId}`)
				).json()) as { messages: { id: string }[] };
				const anchor = view.messages.at(-1)?.id;
				if (!anchor) throw new Error("主线没有可作锚点的消息");
				const forked = (await (
					await api(server, `/api/chat/threads/${threadId}/fork`, {
						method: "POST",
						body: JSON.stringify({ anchorMessageId: anchor }),
					})
				).json()) as { ok: boolean; thread?: { id: string } };
				const branchId = forked.thread?.id;
				if (!forked.ok || !branchId) throw new Error("fork 未产出分支");

				// adopt：入口是分支 id——分支升主线、源线程就地归档
				const adopt = await api(server, `/api/chat/threads/${branchId}/adopt`, {
					method: "POST",
				});
				if (!adopt.ok) throw new Error(`adopt 请求失败：${adopt.status}`);
				const afterAdopt = await list();
				if (afterAdopt.find((t) => t.id === threadId)?.archived !== true)
					throw new Error("源线程未被归档");
				if (afterAdopt.find((t) => t.id === branchId)?.forkOf)
					throw new Error("被收养线程 forkOf 未清空");
				// thread.* 事件按 threadId 归属，不带 writer，故不按 writerId 过滤
				const adopted = await lastEventFor(ws, "thread.adopted");
				if (adopted?.payload.newMainThreadId !== branchId)
					throw new Error("thread.adopted 事件缺失或主线不符");

				// revert：入口是源线程 id——双方身份复原，本步自我闭环不留副作用
				const revert = await api(
					server,
					`/api/chat/threads/${threadId}/revert`,
					{ method: "POST" },
				);
				if (!revert.ok) throw new Error(`revert 请求失败：${revert.status}`);
				const afterRevert = await list();
				if (afterRevert.find((t) => t.id === threadId)?.archived)
					throw new Error("源线程未解档");
				if (
					afterRevert.find((t) => t.id === branchId)?.forkOf?.sourceThreadId !==
					threadId
				)
					throw new Error("被收养线程血统未复原");
				const reverted = await lastEventFor(ws, "thread.adoption_reverted");
				if (reverted?.payload.sourceThreadId !== threadId)
					throw new Error("thread.adoption_reverted 事件缺失");
				return { branchId, adopted: adopted.id, reverted: reverted.id };
			},
		);

		await step("S6c 三路分叉：家族折叠且保留各写者的前提", () =>
			verifyFamilyNotices(ws, server, threadId, [
				branches.branchId,
				branches.emptyBranchId,
			]),
		);

		await verifyCalibration(ws, server, threadId, step);

		const roundIndexDismiss = Number(process.env.E2E_ROUND_INDEX ?? "1");
		if (roundIndexDismiss % 3 === 0) {
			// 判决二（TF-0136）：dismissed/notified ≤ 0.5 才算通过——每轮都
			// dismiss 会把比值顶到 1.0，退化负载发不出真实信号。三分之一轮次
			// dismiss 是「有时觉得打扰」的真实形状。
			await step("S9 dismiss 跨轮生效（本轮为 dismiss 轮）", async () => {
				await api(server, `/api/chat/threads/${threadId}/resume-note/dismiss`, {
					method: "POST",
				});
				const view = (await (
					await api(server, `/api/chat/threads/${threadId}`)
				).json()) as {
					resumeCardDismissed: boolean;
					resumeCard: { inject: boolean } | null;
				};
				if (!view.resumeCardDismissed) throw new Error("dismiss 未落状态");
				if (view.resumeCard?.inject !== false)
					throw new Error("dismiss 后仍注入");
				return "dismiss 生效";
			});
		} else {
			await step(
				"S9 本轮不 dismiss（保留恢复卡，判决二比值数据源）",
				() => "skipped",
			);
		}

		await collectRunReport(ws, step, report);

		report.ok = true;
	} finally {
		await server.stop();
		if (!options.keepWorkspace) {
			await rm(ws.projectDir, { recursive: true, force: true }).catch(() => {});
		}
	}
	return report;
}
