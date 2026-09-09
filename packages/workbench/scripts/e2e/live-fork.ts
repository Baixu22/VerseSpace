/** Persisted provider history, not merely a copied UI transcript. */
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { collectRestoreView } from "../../src/chat/restore-view";
import { api, type E2EWorkspace, sendTurn, startServer } from "./driver";
import { assertLiveAuthorized } from "./live-auth";
import { observeRestore } from "./restoration";

export async function runLiveFork(ws: E2EWorkspace) {
	const implementation = await readFile(
		join(ws.projectDir, "src/base-url.ts"),
		"utf8",
	);
	const development = JSON.parse(
		await readFile(join(ws.projectDir, "runs/live-development.json"), "utf8"),
	) as { reader: string };
	const server = await startServer(ws); // Source process is closed; its provider history is durable.
	try {
		const source = (await (
			await api(server, `/api/chat/threads/${development.reader}`)
		).json()) as { messages: Array<{ id: string }> };
		const anchor = source.messages.at(-1)?.id;
		if (!anchor) throw new Error("持久源线程缺少锚点");
		const branches: Array<{ threadId: string; scenario: string }> = [];
		for (const [index, scenario] of [
			"完整 endpoint 和重复斜杠",
			"反向代理前缀、query 和 fragment",
			"非法 URL、scheme 和嵌入凭据",
		].entries()) {
			const response = await api(
				server,
				`/api/chat/threads/${development.reader}/fork`,
				{ method: "POST", body: JSON.stringify({ anchorMessageId: anchor }) },
			);
			const outcome = (await response.json()) as {
				thread?: { id: string };
				declaration?: { agentContextPlan?: string };
			};
			const child = outcome.thread?.id;
			if (!child || outcome.declaration?.agentContextPlan !== "fork-session")
				throw new Error("持久分支没有真实 provider 继承计划");
			console.log(`[live-fork] 分支 ${index + 1}：${scenario}`);
			await observeRestore(
				server,
				child,
				branches.at(-1)?.threadId ?? development.reader,
			);
			const events = await sendTurn(
				server,
				child,
				`从继承的上下文继续，不要重复之前的改动。读取刚才复核的 URL 函数，重点独立检查「${scenario}」，将 JSON {verdict:'pass'或'fail',findings:字符串数组} 写到 src/branch-${index + 1}.review.json，不改其他文件。`,
			);
			if (
				events.some((event) => event.type === "error") ||
				!events.some((event) => event.type === "done")
			)
				throw new Error("真实模型分支回合失败");
			const view = (await (
				await api(server, `/api/chat/threads/${child}`)
			).json()) as Awaited<ReturnType<typeof collectRestoreView>>;
			if (
				!view.meta.forkInheritance?.agentContextInherited ||
				!view.meta.forkInheritance?.premiseInherited
			)
				throw new Error("分支未记录真实上下文和读集继承");
			branches.push({ threadId: child, scenario });
		}
		const first = branches[0]!.threadId;
		await observeRestore(server, first, branches.at(-1)!.threadId);
		const revisit = await sendTurn(
			server,
			first,
			"再次读取 src/base-url.ts，对照刚才完整 endpoint 的检查，如果有剩余问题就明确列出；不修改文件。",
		);
		if (revisit.some((event) => event.type === "error"))
			throw new Error("兄弟分支返回回合失败");
		const after = (await (
			await api(server, `/api/chat/threads/${development.reader}`)
		).json()) as { messages: unknown[] };
		if (JSON.stringify(after.messages) !== JSON.stringify(source.messages))
			throw new Error("分支改动了源线程消息");
		if (
			(await readFile(join(ws.projectDir, "src/base-url.ts"), "utf8")) !==
			implementation
		)
			throw new Error("复核分支改动了已独立验收的实现");
		const result = {
			source: development.reader,
			branches,
			inheritance: "provider-history-and-premise",
			sourceTranscriptUnchanged: true,
			actor: "live-model-with-scripted-switches",
		};
		await writeFile(
			join(ws.projectDir, "runs/live-fork.json"),
			JSON.stringify(result, null, 2),
		);
		return result;
	} finally {
		await server.stop();
	}
}

if (import.meta.main) {
	const projectDir = process.argv[2];
		if (!projectDir) throw new Error("需要已授权的 live 工作区");
		await assertLiveAuthorized(projectDir, "需要已授权的 live 工作区");
	await runLiveFork({
		projectDir,
		entry: resolve(import.meta.dir, "../../src/index.ts"),
		agentScript: resolve(import.meta.dir, "live-agent.ts"),
	});
}
