/** A real coding task, not a fixed READ/WRITE directive replay. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	api,
	cli,
	type E2EWorkspace,
	lastEventFor,
	sendTurn,
	startServer,
	waitFor,
} from "./driver";
import { validateWithCorrections } from "./live-validation";
import { assertLiveAuthorized } from "./live-auth";
import { observeRestore } from "./restoration";

export async function runLiveDevelopment(ws: E2EWorkspace) {
		await assertLiveAuthorized(ws.projectDir, "仅允许已授权的隔离工作区");
	await mkdir(join(ws.projectDir, "runs"), { recursive: true });
	await writeFile(
		join(ws.projectDir, "src/base-url.ts"),
		'export function buildChatEndpoint(base: string): string {\n\treturn base.replace(/\\/$/, "") + "/chat/completions";\n}\n',
	);
	const requirement = [
		"修复 buildChatEndpoint(base: string): string。当前代码对完整 endpoint 会重复拼接。",
		"接受 HTTP/HTTPS 基址或已完整的 /chat/completions 地址，保留反向代理路径前缀。",
		"去掉两端空白、复制时混入的中英文引号及 pathname 末尾多余斜杠。",
		"保留 URL query，清除无用 fragment；拒绝 ftp/file 等非 HTTP(S) scheme 及 URL username/password。",
		"只改 src/base-url.ts，保持 export 签名，使用标准 URL，不加依赖，不访问网络/文件/环境变量。",
		"所有输入先用 new URL 验证协议与凭据，完整端点也不例外；然后在 pathname 去尾斜杠并判断是否已经以 /chat/completions 结尾，避免重复拼接。",
		"路径和 query 中的 @ 是合法字符；凭据检查只看 URL.username / URL.password，不用 includes('@') 拒绝整个地址。",
		'验收例：完整 https://openrouter.ai/api/v1/chat/completions 必须原样返回，不能再拼接一次；"https://x.test/v1/" 去引号后得到 https://x.test/v1/chat/completions；https://x.test/v1#old 清除 fragment 后得到 https://x.test/v1/chat/completions。引号只去两端，不改变 URL 中间的字符。',
	].join("\n");
	await writeFile(
		join(ws.projectDir, "src/base-url.requirements.txt"),
		requirement,
	);
	const server = await startServer(ws);
	try {
		const create = async (title: string) => {
			const response = await api(server, "/api/chat/threads", {
				method: "POST",
				body: JSON.stringify({ title }),
			});
			if (!response.ok) throw new Error(`建立开发线程失败 ${response.status}`);
			return ((await response.json()) as { id: string }).id;
		};
		const send = async (thread: string, text: string) => {
			const events = await sendTurn(server, thread, text);
			const error = events.find((event) => event.type === "error");
			if (error || !events.some((event) => event.type === "done"))
				throw new Error(`真实开发回合失败：${JSON.stringify(error)}`);
			return events;
		};
		const reader = await create("真实模型：旧前提与恢复复核");
		const writer = await create("真实模型：第三方 endpoint 兼容修复");
		console.log("[live-dev] 读取旧实现，建立真实前提");
		await send(
			reader,
			"用 Read 读取 src/base-url.ts，说明输入完整 https://openrouter.ai/api/v1/chat/completions 会得到什么结果。不要修改文件。",
		);
		await api(server, `/api/chat/threads/${reader}/leave`, { method: "POST" });
		console.log("[live-dev] 模型自主修复 endpoint 兼容问题");
		await send(
			writer,
			"先读取 src/base-url.requirements.txt 和 src/base-url.ts，按需求实际修复代码并用 Write 保存，然后简述改动。不要修改其他文件。",
		);
		const independentChecks = await validateWithCorrections(
			ws.projectDir,
			async (failures) => {
				console.log(
					`[live-dev] 独立验收未通过 ${failures.length} 项，模型纠正`,
				);
				await send(
					writer,
					`独立验收失败如下：${JSON.stringify(failures)}。先用 Read 读当前 src/base-url.ts，**只做最小必要的定点修改**（不要重写整个文件、不要重复解释整体设计），用一次 Write 保存修改后的完整 src/base-url.ts，一句话说明改了什么。不改需求、用例或其他文件。`,
				);
			},
		);
		const implementation = await readFile(
			join(ws.projectDir, "src/base-url.ts"),
			"utf8",
		);
		if (!implementation.includes("new URL"))
			throw new Error("模型未写出符合基本要求的实现");
		if (
			(await readFile(
				join(ws.projectDir, "src/base-url.requirements.txt"),
				"utf8",
			)) !== requirement
		)
			throw new Error("模型改动了只读需求");
		await waitFor(
			"旧读者前提失效",
			async () => Boolean(await lastEventFor(ws, "premise_stale", reader)),
			45_000,
		);
		const restored = await observeRestore(server, reader);
		if (
			!restored.resumeCard?.facts.some(
				(fact) => fact.path === "src/base-url.ts",
			)
		)
			throw new Error("真实代码变化未出现在恢复卡");
		await api(server, `/api/chat/threads/${reader}/resume-note/consume`, {
			method: "POST",
			body: JSON.stringify({ surface: "card" }),
		});
		const seal = async () => {
			const result = await cli(ws, [
				"--json",
				"premises",
				"seal",
				"--target",
				"src/base-url.ts",
				"--writer",
				reader,
			]);
			if (![0, 2].includes(result.code ?? -1))
				throw new Error(`封印命令异常：${result.code}`);
			return JSON.parse(result.stdout.slice(result.stdout.indexOf("{"))) as {
				blocked: boolean;
				decision: string;
			};
		};
		// The configured limit permits three blocks; the fourth hit downgrades.
		const before = [await seal(), await seal(), await seal(), await seal()];
		if (!before[0]?.blocked || before.at(-1)?.blocked)
			throw new Error("陈旧前提封印/连续阻断降级未生效");
		console.log("[live-dev] 旧读者恢复、复读并独立复核新实现");
		await send(
			reader,
			"其他写者已修复这个文件。先 Read src/base-url.ts 和 src/base-url.requirements.txt，基于实际新代码复核每条需求，把 JSON 格式 {verdict: 'pass'或'fail', findings: 字符串数组} 的独立结论写入 src/base-url.review.json。不要修改实现；不能仅因作者说完成就认可。",
		);
		const after = await seal();
		if (after.blocked) throw new Error("真实复读之后仍被旧前提阻断");
		if (
			(await readFile(join(ws.projectDir, "src/base-url.ts"), "utf8")) !==
			implementation
		)
			throw new Error("复核线程改动了已独立验收的实现");
		const review = JSON.parse(
			await readFile(join(ws.projectDir, "src/base-url.review.json"), "utf8"),
		) as unknown;
		const evidence = {
			source: "live-model-development",
			reader,
			writer,
			requirement,
			implementation: "src/base-url.ts",
			modelReview: review,
			independentChecks,
			sealBefore: before,
			sealAfter: after,
			limitations:
				"模型实现与模型复核来自真实工具回合；控制器安排并发和恢复。实现通过独立 URL 用例；模型意见不记为人工认可。",
		};
		await writeFile(
			join(ws.projectDir, "runs/live-development.json"),
			JSON.stringify(evidence, null, 2),
		);
		return evidence;
	} finally {
		await server.stop();
	}
}

if (import.meta.main) {
	const projectDir = process.argv[2];
	if (!projectDir) throw new Error("需要已授权的 live E2E 工作区路径");
	await runLiveDevelopment({
		projectDir,
		entry: resolve(import.meta.dir, "../../src/index.ts"),
		agentScript: resolve(import.meta.dir, "live-agent.ts"),
	});
}
