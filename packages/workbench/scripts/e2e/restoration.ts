import {
	api,
	type E2EWorkspace,
	lastEventFor,
	type Server,
	sendTurn,
} from "./driver";
import type { StepRunner } from "./scenario";

interface RestoreView {
	messages: Array<{ id: string }>;
	resumeCardDismissed: boolean;
	resumeCard: {
		facts: Array<{ path: string; refs: string[]; source: string }>;
		coverage: { status: string; text: string };
		narrative: Array<{ text: string; refs: string[] }>;
		inject: boolean;
	} | null;
}

/** Same order and payload as the UI: load, observe switch, observe restore. */
export async function observeRestore(
	server: Server,
	threadId: string,
	fromThreadId: string | null = null,
): Promise<RestoreView> {
	const response = await api(server, `/api/chat/threads/${threadId}`);
	if (!response.ok) throw new Error(`加载恢复线程失败：${response.status}`);
	const view = (await response.json()) as RestoreView;
	for (const action of ["switch", "restore"]) {
		const observed = await api(
			server,
			`/api/chat/threads/${threadId}/${action}`,
			{
				method: "POST",
				body: JSON.stringify({
					fromThreadId,
					...(action === "restore"
						? {
								resumeCardVisible: Boolean(
									view.resumeCard && !view.resumeCardDismissed,
								),
								lastMessageId: view.messages.at(-1)?.id ?? null,
							}
						: {}),
				}),
			},
		);
		if (!observed.ok) throw new Error(`${action} 观测失败：${observed.status}`);
	}
	return view;
}

export async function verifyRestoration(
	ws: E2EWorkspace,
	server: Server,
	threadId: string,
	step: StepRunner,
): Promise<{ branchId: string; emptyBranchId: string }> {
	await step("S5 恢复线程：恢复卡事实/覆盖率/注记", async () => {
		const view = await observeRestore(server, threadId);
		const card = view.resumeCard;
		if (!card) throw new Error("恢复卡未渲染");
		if (card.facts.length === 0) throw new Error("事实段为空");
		if (card.facts.some((f) => f.refs.length === 0)) {
			throw new Error("存在无 refs 的事实行");
		}
		if (card.coverage.status !== "available") {
			throw new Error(`覆盖率不可用：${card.coverage.status}`);
		}
		if (card.facts.every((f) => f.source !== "read-set")) {
			throw new Error("事实段没有读集行");
		}
		if (
			card.facts.some(
				(fact) => fact.source === "read-set" && fact.path === "src/notes.md",
			)
		) {
			throw new Error("读取范围末尾之外的追加被误报成失效前提");
		}
		for (const ref of new Set(
			[...card.facts, ...card.narrative].flatMap((row) => row.refs),
		)) {
			const response = await api(
				server,
				`/api/chat/threads/${threadId}/evidence?ref=${encodeURIComponent(ref)}`,
			);
			if (!response.ok) throw new Error(`证据引用请求失败：${ref}`);
			const evidence = (await response.json()) as {
				kind: string;
				content: string;
			};
			if (evidence.kind === "unavailable" || !evidence.content)
				throw new Error(`无法溯源：${ref}`);
		}
		// 判决一（TF-0136）的数据源：卡片被真正消费 + 非.dismiss 的手动动作
		await api(server, `/api/chat/threads/${threadId}/resume-note/consume`, {
			method: "POST",
			body: JSON.stringify({ surface: "card" }),
		});
		await api(server, `/api/chat/threads/${threadId}/resume-action`, {
			method: "POST",
			body: JSON.stringify({ action: "resume_card_revealed" }),
		});
		return {
			facts: card.facts.length,
			coverage: card.coverage.text,
		};
	});

	const forkChild = await step(
		"S6 分叉 + 子分支写 stale 文件（R10）",
		async () => {
			const messages = (await (
				await api(server, `/api/chat/threads/${threadId}`)
			).json()) as { messages: Array<{ id: string }> };
			const anchor = messages.messages.at(-1)?.id;
			if (!anchor) throw new Error("没有可分叉的锚点消息");
			const forkRes = await api(server, `/api/chat/threads/${threadId}/fork`, {
				method: "POST",
				body: JSON.stringify({ anchorMessageId: anchor }),
			});
			const outcome = (await forkRes.json()) as { thread?: { id: string } };
			const childId = outcome.thread?.id;
			if (!childId) throw new Error("fork 未返回子线程");
			await sendTurn(
				server,
				childId,
				[
					"分支上继续。",
					"WRITE src/alpha.ts",
					'export const alpha = "v4 on branch";',
					"__END_WRITE__",
				].join("\n"),
			);
			const view = (await (
				await api(server, `/api/chat/threads/${threadId}`)
			).json()) as {
				resumeCard: {
					facts: Array<{
						source: string;
						refs: string[];
						annotation?: { rule: string };
						branch?: { threadId: string; paths: string[] };
					}>;
				} | null;
			};
			const branchRow = view.resumeCard?.facts.find(
				(f) => f.source === "branch",
			);
			if (!branchRow) throw new Error("R10 分支行未渲染");
			if (branchRow.annotation?.rule !== "R10") throw new Error("注记不是 R10");
			if (branchRow.branch?.threadId !== childId)
				throw new Error("分支指针错误");
			if (!branchRow.branch.paths.includes("src/alpha.ts")) {
				throw new Error("分支写集缺 src/alpha.ts");
			}
			if (branchRow.refs.length === 0) throw new Error("R10 行无事件引用");
			return {
				childId,
				paths: branchRow.branch.paths,
				refs: branchRow.refs.length,
			};
		},
	);

	await step("S6a 查看分支手势（TF-0151 的记账探针）", async () => {
		// UI 的「查看分支」按钮：先在源线程记 resume_branch_opened，再切换
		// 过去。stats 的 lifecycle.resumeActions 计数与 restoreFirstAction
		// 归因都吃这条事件——没有这条腿，分支消费在租户样本里永远缺席。
		await api(server, `/api/chat/threads/${threadId}/resume-action`, {
			method: "POST",
			body: JSON.stringify({ action: "resume_branch_opened" }),
		});
		const event = await lastEventFor(ws, "thread.resume_action");
		if (event?.payload.action !== "resume_branch_opened") {
			throw new Error("resume_branch_opened 未落事件账");
		}
		if (event.payload.threadId !== threadId) {
			throw new Error("resume_branch_opened 记在了错误的线程");
		}
		return { action: event.payload.action };
	});

	const emptyBranchId = await step("S6b 空分支零痕迹", async () => {
		const messages = (await (
			await api(server, `/api/chat/threads/${threadId}`)
		).json()) as { messages: Array<{ id: string }> };
		const anchor = messages.messages.at(-1)?.id;
		if (!anchor) throw new Error("没有可分叉的锚点消息");
		const forkRes = await api(server, `/api/chat/threads/${threadId}/fork`, {
			method: "POST",
			body: JSON.stringify({ anchorMessageId: anchor }),
		});
		if (!forkRes.ok) throw new Error(`空分支 fork 失败：${forkRes.status}`);
		const emptyFork = (await forkRes.json()) as { thread?: { id: string } };
		if (!emptyFork.thread?.id) throw new Error("空分支没有返回线程 ID");
		const view = (await (
			await api(server, `/api/chat/threads/${threadId}`)
		).json()) as {
			resumeCard: {
				facts: Array<{ source: string; branch?: { threadId: string } }>;
			} | null;
		};
		const branchRows = (view.resumeCard?.facts ?? []).filter(
			(f) => f.source === "branch",
		);
		if (branchRows.length !== 1) {
			throw new Error(`空分支留下痕迹：${branchRows.length} 行分支事实`);
		}
		if (branchRows[0]?.branch?.threadId !== forkChild.childId) {
			throw new Error("留下的分支行不是写过的那个分支");
		}
		return emptyFork.thread.id;
	});
	return { branchId: forkChild.childId, emptyBranchId };
}
