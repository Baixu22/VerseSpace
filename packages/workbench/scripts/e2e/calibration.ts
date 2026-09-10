import {
	api,
	cli,
	cliJson,
	type E2EWorkspace,
	lastEventFor,
	lastEventId,
	type Server,
	sendTurn,
} from "./driver";
import type { StepRunner } from "./scenario";

export async function verifyOptionalLlm(
	server: Server,
	step: StepRunner,
): Promise<void> {
	// 真 LLM 腿（可选）：提供 E2E_LLM_* 环境变量时，通过 /api/config/chat
	// 把 provider 切到 openai-chat 跑一轮真实的流式模型回合，然后切回来——
	// HTTP provider 没有工具通道（足迹 unobservable），这一腿验证的是
	// 消息管线、SSE 消费与 provider 事实记账，不是足迹。
	if (process.env.E2E_LLM_KEY && process.env.E2E_LLM_MODEL) {
		await step("S1b 真 LLM 回合（openai-chat 流式）", async () => {
			const patch = (body: Record<string, unknown>) =>
				api(server, "/api/config/chat", {
					method: "PATCH",
					body: JSON.stringify(body),
				});
			await patch({
				provider: "openai-chat",
				baseUrl: process.env.E2E_LLM_BASE_URL ?? "https://openrouter.ai/api/v1",
				model: process.env.E2E_LLM_MODEL,
			});
			try {
				const llmThread = (await (
					await api(server, "/api/chat/threads", {
						method: "POST",
						body: JSON.stringify({ title: "E2E 真 LLM 线程" }),
					})
				).json()) as { id: string };
				const events = await sendTurn(
					server,
					llmThread.id,
					"只回复一句不超过二十个字的中文：收到，集成测试连通。",
				);
				const types = events.map((e) => e.type);
				if (types.includes("error")) {
					const err = events.find((e) => e.type === "error");
					throw new Error(`LLM 回合报错：${JSON.stringify(err).slice(0, 300)}`);
				}
				if (!types.includes("delta")) {
					throw new Error(`LLM 流式无 delta：${types.join(",")}`);
				}
				const view = (await (
					await api(server, `/api/chat/threads/${llmThread.id}`)
				).json()) as { messages: Array<{ role: string; text: string }> };
				const reply = view.messages.find((m) => m.role === "assistant");
				if (!reply || reply.text.trim().length === 0) {
					throw new Error("LLM 回复未落库");
				}
				return { reply: reply.text.slice(0, 80), events: types.length };
			} finally {
				// 恢复 claude provider，后续 fake-agent 腿不受影响
				await patch({ provider: "claude", apiKey: "" });
			}
		});
	}
}

export async function verifyCalibration(
	ws: E2EWorkspace,
	server: Server,
	threadId: string,
	step: StepRunner,
): Promise<void> {
	await step("S7 封印：hook 路径 block + 人工复核", async () => {
		// 封印以 hook 约定返回：阻断 = 退出 2 + stderr 阻断理由，JSON 在 stdout。
		const sealProc = await cli(ws, [
			"--json",
			"premises",
			"seal",
			"--target",
			"src/alpha.ts",
			"--writer",
			threadId,
		]);
		if (sealProc.code !== 0 && sealProc.code !== 2) {
			throw new Error(
				`seal 异常退出 ${sealProc.code}：${sealProc.stderr.slice(0, 200)}`,
			);
		}
		const seal = JSON.parse(
			sealProc.stdout.slice(sealProc.stdout.indexOf("{")),
		) as {
			blocked: boolean;
			decision: string;
			matchedDeclarations: string[];
		};
		if (!seal.blocked) throw new Error(`封印未阻断：${JSON.stringify(seal)}`);
		if (!seal.matchedDeclarations.includes("src/alpha.ts")) {
			throw new Error("阻断未命中 alpha 声明");
		}
		const sealEventId = await lastEventId(ws, "seal.decided");
		if (!sealEventId) throw new Error("seal.decided 事件无 id");
		const review = await cli(ws, [
			"premises",
			"review-seal",
			sealEventId,
			"--correct",
			"--reason",
			"集成验证：阻断命中的确是已失效前提",
		]);
		if (review.code !== 0) {
			throw new Error(`review-seal 失败：${review.stderr || review.stdout}`);
		}
		return { sealEventId, blocked: seal.blocked };
	});

	await step("S7b 源线程回头复读（通知结局=repaired 的数据源）", async () => {
		// 通知已排队进源线程；写者下一轮把失效文件重新读一遍——真实日用的
		// 「收到通知，去看了一眼」。结局标记 repaired，而不是 no-later-activity
		// 的 unknown：判决二的 dismissed/ignored 比值因此保持低位且诚实。
		const events = await sendTurn(
			server,
			threadId,
			["通知说 alpha 变了，去看一眼。", "READ src/alpha.ts"].join("\n"),
		);
		if (!events.map((e) => e.type).includes("done")) {
			throw new Error("回头复读回合未完成");
		}
		return "re-checked alpha";
	});

	await step("S8 兴趣降低：观察 → lower → 不可见", async () => {
		const before = await cliJson<{
			visible: string[];
			reductions: { total: number };
		}>(ws, ["context", "list", "--writer", threadId]);
		if (!before.visible.includes("src/notes.md")) {
			throw new Error(`读集未进兴趣投影：${before.visible.join(",")}`);
		}
		const lower = await cliJson<{ recorded: boolean }>(ws, [
			"context",
			"lower",
			"src/notes.md",
			"--writer",
			threadId,
		]);
		if (!lower.recorded) throw new Error("lower 未记录");
		const after = await cliJson<{ visible: string[] }>(ws, [
			"context",
			"list",
			"--writer",
			threadId,
		]);
		if (after.visible.includes("src/notes.md")) {
			throw new Error("降低后仍然可见");
		}
		return { before: before.visible, after: after.visible };
	});

	// L1 认可手势（TF-0154）：对当前投影的地标做人工复核。五分之一轮次
	// reject—— endorse 占比 4/5 = 0.8，正好落在 L1 验收的 80% 口径上；
	// 全 endorse 又是退化负载，发不出真实信号。
	const roundIndex = Number(process.env.E2E_ROUND_INDEX ?? "1");
	await step("S8b 地标认可手势（TF-0057 L1 数据源）", async () => {
		const list = await cliJson<{ landmarks: Array<{ handle: string }> }>(ws, [
			"context",
			"list",
			"--writer",
			threadId,
		]);
		const top = list.landmarks[0]?.handle;
		if (!top) throw new Error("地标投影为空");
		const rejectRound = roundIndex % 5 === 0;
		const review = await cli(ws, [
			"--json",
			"context",
			"review",
			top,
			"--writer",
			threadId,
			rejectRound ? "--reject" : "--endorse",
			...(rejectRound ? ["--reason", "这条不是核心"] : []),
		]);
		if (review.code !== 0) {
			throw new Error(`review 失败：${review.stderr || review.stdout}`);
		}
		const reviewed = await lastEventFor(ws, "landmark.reviewed", threadId);
		if (!reviewed) throw new Error("landmark.reviewed 事件未落库");
		return { handle: top, verdict: rejectRound ? "reject" : "endorse" };
	});
}
