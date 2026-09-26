/**
 * F-03 / TF-0264：真实 codex 的写会被封印吗？
 *
 * 这不是普通的单测——它会用**真实 codex CLI**（模型由 CODEX_HOME 决定，见
 * scripts/verify/codex-gateway.toml）在**一条 stale premise** 上写文件，然后看封印有没有介入。
 * 现有 codex 集成测试用的是 stub，从来没跑过真实 codex，所以这个空缺一直没被回答。
 *
 * 实验设计（对照是关键）：
 *   1. 造一条真的 stale premise（记录读 → 改文件 → reconcile）；
 *   2. 让真实 codex 通过 workbench 的 codex 车道写那个文件；
 *   3. 观察：文件变了吗？events.jsonl 里有 seal.decided 吗？（预期：变了，没有）
 *   4. **对照**：对同一条 stale premise 直接调 decideSeal（也就是 Claude Code hook 调的同一个
 *      函数）→ 预期 block，并留下 seal.decided。
 *   没有第 4 步，「没被封印」可能只是因为那条前提本来就不 stale。
 *
 * 退出码：0 = 观测完成（结论见输出）· 2 = 无法测量（前提没造出来 / codex 没起来 / 回合失败）
 *
 * 用法（密钥与 CODEX_HOME 由环境给，见 docs/handoff/2026-09-26-codex-preconditions.md）：
 *   bun packages/workbench/scripts/verify/codex-write-seal.ts --json
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ChatThreads, type RunEvent } from "../../src/chat/threads";
import { pendingPremiseNotices } from "../../src/runtime/delivery";
import { reconcilePremises } from "../../src/runtime/premises";
import { decideSeal } from "../../src/runtime/seal";
import { SEAL_EVENT } from "../../src/runtime/seal-counts";
import { makeTempWorkbench } from "../../src/test/fixtures";

const asJson = process.argv.includes("--json");
// stale = the premise is stale (the seal must block). fresh = identical codex
// config and prompt, but no stale claim (the write must land). The difference
// between the two runs is the ONLY thing that can explain a block — without it,
// "seal blocked it" and "codex sandbox blocked it" are one observation.
const CASE = (process.argv[process.argv.indexOf("--case") + 1] ?? "stale") as
	| "stale"
	| "fresh";
const TARGET = "src/target.ts";
const PROMPT =
	"Run exactly this shell command and then report what happened: " +
	"echo '// written by codex' >> src/target.ts";

type Verdict = {
	measured: boolean;
	reason?: string;
	case: string;
	staleClaims: number;
	codexCommand: string | null;
	turnEvents: string[];
	writeLanded: boolean;
	contentBefore: string;
	contentAfter: string;
	sealEventsAfterCodex: number;
	controlDecision: string | null;
	sealEventsAfterControl: number | null;
};

const verdict: Verdict = {
	measured: false,
	case: CASE,
	staleClaims: 0,
	codexCommand: process.env.WORKBENCH_CODEX_COMMAND ?? null,
	turnEvents: [],
	writeLanded: false,
	contentBefore: "",
	contentAfter: "",
	sealEventsAfterCodex: 0,
	controlDecision: null,
	sealEventsAfterControl: null,
};

const ws = await makeTempWorkbench();
const chat = new ChatThreads(ws.bb);
let threadId: string | undefined;

function bail(reason: string): never {
	verdict.reason = reason;
	if (asJson) process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
	else console.error(`无法测量：${reason}`);
	process.exit(2);
}

try {
	// 1. A genuinely stale premise: writer w read src/target.ts, then it changed.
	const before = "export const target = 1;\n";
	await mkdir(join(ws.projectDir, "src"), { recursive: true });
	await writeFile(join(ws.projectDir, TARGET), before, "utf8");
	if (CASE === "stale") {
		await ws.bb.sessions.register("w", "agent", "W");
		await ws.bb.sessions.recordActivity("w", {
			activity: "read-target",
			agent: "w",
			used: [{ path: TARGET, version: "v1", durability: "volatile" }],
			generated: [],
		});
		await writeFile(
			join(ws.projectDir, TARGET),
			"export const target = 2;\n",
			"utf8",
		);
	}
	await reconcilePremises(ws.bb);
	const claims = (await pendingPremiseNotices(ws.bb)).flatMap((n) => n.claims);
	verdict.staleClaims = claims.length;
	if (CASE === "stale" && claims.length === 0) {
		bail("没能造出 stale premise（对照就失去意义）");
	}

	verdict.contentBefore = await readFile(join(ws.projectDir, TARGET), "utf8");

	// 2. Drive the real codex through the product's own lane.
	if (!verdict.codexCommand) {
		bail("缺 WORKBENCH_CODEX_COMMAND（真实 codex 的绝对路径）");
	}
	await ws.bb.config.save({ project: "", chat: { provider: "codex" } });
	const thread = await chat.create();
	threadId = thread.id;
	const events: RunEvent[] = [];
	try {
		await chat.run(thread.id, PROMPT, (event) => {
			events.push(structuredClone(event));
		});
	} catch (error) {
		bail(`codex 回合抛错：${(error as Error).message}`);
	}
	verdict.turnEvents = events.map((event) => event.type);
	if (events.some((event) => event.type === "error")) {
		const failure = events.find((event) => event.type === "error");
		bail(`codex 回合以 error 收尾：${JSON.stringify(failure).slice(0, 300)}`);
	}

	// 3. Did the write land, and did the seal say anything?
	verdict.contentAfter = await readFile(join(ws.projectDir, TARGET), "utf8");
	verdict.writeLanded = verdict.contentAfter !== verdict.contentBefore;
	verdict.sealEventsAfterCodex = (
		await ws.bb.events.query({ type: SEAL_EVENT })
	).length;

	// 4. Control: the very function the Claude Code hook calls, on the same claim.
	const outcome = await decideSeal(ws.bb, {
		target: join(ws.projectDir, TARGET),
		writerId: "w",
		claims,
	});
	verdict.controlDecision = outcome.decision;
	verdict.sealEventsAfterControl = (
		await ws.bb.events.query({ type: SEAL_EVENT })
	).length;
	verdict.measured = true;
} finally {
	if (threadId) chat.cancel(threadId);
	await ws.cleanup();
}

if (asJson) {
	process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
} else {
	console.log("=== 真实 codex 写侧封印验收 ===");
	console.log(`stale premise      ${verdict.staleClaims} 条`);
	console.log(`codex 命令          ${verdict.codexCommand}`);
	console.log(`回合事件            ${verdict.turnEvents.join(", ")}`);
	console.log(`写入是否落盘        ${verdict.writeLanded ? "是" : "否"}`);
	console.log(`codex 之后 seal 事件 ${verdict.sealEventsAfterCodex}（预期 0）`);
	console.log(
		`对照（decideSeal）  ${verdict.controlDecision}，之后 seal 事件 ${verdict.sealEventsAfterControl}`,
	);
}
process.exit(verdict.measured ? 0 : 2);
