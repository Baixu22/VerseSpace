/**
 * TF-0194 观察窗驱动器（steward 口径）：镜像 workbench-ui 的真实手势序列，
 * 每一次调用都是一个由代理在真实开发轮中做出的决定——本脚本只提供机制，
 * 不提供循环：没有「重复 N 次」的回放入口，配额只能靠一轮一轮真实工作凑。
 *
 * 手势序列与 apps/workbench-ui 的 selection-slice / resume-card 对齐：
 *   open   = GET 视图 → POST switch → POST restore(resumeCardVisible) → 渲染带分支行的卡 → POST shown（按 baseline 去重）
 *   expand = POST resume-action resume_fact_opened label
 *   bopen  = POST resume-action resume_branch_opened label（随后自行 open 分支线程）
 *   dismiss= POST resume-note/dismiss
 */
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");
const STATE = join(import.meta.dir, "server.json");
const SHOWN_STATE = join(import.meta.dir, "shown-state.json");

interface ServerState {
	port: number;
	token: string;
	startedAt: string;
}

const server: ServerState = JSON.parse(await readFile(STATE, "utf8"));

async function api(path: string, init?: RequestInit): Promise<Response> {
	return fetch(`http://127.0.0.1:${server.port}${path}`, {
		...init,
		headers: {
			"x-workbench-token": server.token,
			...(init?.body ? { "content-type": "application/json" } : {}),
			connection: "close",
		},
	});
}

const json = async (path: string, init?: RequestInit) =>
	(await api(path, init)).json();

interface FactRow {
	path: string;
	summary: string;
	source: string;
	branch?: { threadId: string };
	annotation?: { rule: string; label: string };
}

function printCard(card: {
	coverage: { text: string };
	narrative: unknown[];
	facts: FactRow[];
	dismissed: boolean;
} | null): void {
	if (!card) {
		console.log("卡片：无");
		return;
	}
	console.log(`覆盖行：${card.coverage.text}`);
	console.log(`叙事 ${card.narrative.length} 条 / 事实 ${card.facts.length} 条${card.dismissed ? "（已 dismiss）" : ""}`);
	for (const fact of card.facts) {
		console.log(
			`  [${fact.source}] ${fact.path}${fact.annotation ? ` ← ${fact.annotation.rule}:${fact.annotation.label}` : ""}`,
		);
		const lines = fact.summary.split("\n").filter((line) => line.trim());
		for (const line of lines) console.log(`      ${line}`);
	}
}

async function postJson(path: string, body: unknown): Promise<void> {
	const res = await api(path, { method: "POST", body: JSON.stringify(body) });
	if (!res.ok) {
		throw new Error(`POST ${path} → ${res.status}：${await res.text()}`);
	}
}

/** 镜像 UI 的 open 序列；返回视图数据供后续手势用。 */
async function openView(threadId: string, fromThreadId: string | null) {
	const view = (await json(`/api/chat/threads/${threadId}`)) as {
		meta: { id: string; title: string };
		messages: Array<{ id: string }>;
		resumeCard: Parameters<typeof printCard>[0];
		resumeCardDismissed: boolean;
		readSetDiff: { baseline: { eventId: string | null } | null } | null;
	};
	if (fromThreadId) {
		await postJson(`/api/chat/threads/${threadId}/switch`, {
			fromThreadId,
		}).catch(() => {});
	}
	await postJson(`/api/chat/threads/${threadId}/restore`, {
		fromThreadId,
		resumeCardVisible: Boolean(view.resumeCard && !view.resumeCardDismissed),
		lastMessageId: view.messages.at(-1)?.id ?? null,
	}).catch(() => {});
	// 镜像 ResumeCard 的展示上报：有分支行才报，按恢复边界去重。
	const branchRows = (view.resumeCard?.facts ?? []).filter(
		(fact) => fact.source === "branch" && fact.branch,
	);
	if (view.resumeCard && !view.resumeCardDismissed && branchRows.length > 0) {
		const key = `${threadId}|${view.readSetDiff?.baseline?.eventId ?? ""}|${branchRows
			.map((fact) => fact.branch!.threadId)
			.join(",")}`;
		const seen = new Set<string>(
			JSON.parse(await readFile(SHOWN_STATE, "utf8").catch(() => "[]")) as string[],
		);
		if (!seen.has(key)) {
			seen.add(key);
			await writeFile(SHOWN_STATE, JSON.stringify([...seen], null, 2));
			await postJson(`/api/chat/threads/${threadId}/resume-card/shown`, {
				branchRows: branchRows.map((fact) => `branch:${fact.branch!.threadId}`),
			});
			console.log(`[shown] 上报 ${branchRows.length} 条分支行（key=${key.slice(0, 40)}…）`);
		} else {
			console.log("[shown] 同一恢复边界已上报过，跳过（UI 去重语义）");
		}
	}
	console.log(`线程 ${threadId}（${view.meta.title}）：消息 ${view.messages.length} 条，末条锚点 ${view.messages.at(-1)?.id ?? "无"}`);
	printCard(view.resumeCard);
	return view;
}

const [command, ...args] = process.argv.slice(2);
switch (command) {
	case "open": {
		await openView(args[0]!, args[1] ?? null);
		break;
	}
	case "threads": {
		const threads = (await json("/api/chat/threads")) as Array<{
			id: string;
			title: string;
		}>;
		for (const thread of threads) console.log(`${thread.id}  ${thread.title}`);
		break;
	}
	case "new": {
		const created = (await json("/api/chat/threads", {
			method: "POST",
			body: JSON.stringify({ title: args[0] ?? "未命名" }),
		})) as { id: string };
		console.log(created.id);
		break;
	}
	case "send":
	case "resend": {
		// 发出回合后不消费流（长流在 Bun 客户端偶发 DATA_CLONE_ERR/ECONNRESET，
		// 服务端总是完整落盘）——轮询 meta 至 idle，再从磁盘读转录。
		const [threadId, promptFile] = args;
		const text = (await readFile(promptFile!, "utf8")).trim();
		const resend = command === "resend";
		console.log(`[send] ${threadId} ← ${text.length} 字${resend ? "（resend）" : ""}`);
		const res = await api(`/api/chat/threads/${threadId}/messages`, {
			method: "POST",
			body: JSON.stringify({ text, resend }),
		});
		if (!res.ok) {
			throw new Error(`messages ${res.status}：${await res.text()}`);
		}
		await res.body?.cancel().catch(() => {});
		const metaPath = join(ROOT, ".workbench", "threads", threadId!, "meta.json");
		const transcriptPath = join(ROOT, ".workbench", "threads", threadId!, "messages.jsonl");
		const deadline = Date.now() + 600_000;
		let status = "";
		while (Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 5_000));
			try {
				status = (JSON.parse(await readFile(metaPath, "utf8")) as { status?: string }).status ?? "";
			} catch {
				// 瞬态读失败继续轮询
			}
			if (status === "idle") break;
			if (status === "" ) continue;
			if (status !== "running") {
				console.log(`[send] 状态 ${status}，停止等待`);
				break;
			}
		}
		const lines = (await readFile(transcriptPath, "utf8"))
			.trim()
			.split(/\r?\n/)
			.filter((line) => line.trim())
			.map((line) => JSON.parse(line) as { role?: string; text?: string });
		const lastAssistant = [...lines].reverse().find((m) => m.role === "assistant");
		console.log(`[send] 结束（status=${status}）：转录 ${lines.length} 条`);
		console.log((lastAssistant?.text ?? "（无 assistant 消息）").slice(0, 400));
		break;
	}
	case "fork": {
		const out = (await json(`/api/chat/threads/${args[0]}/fork`, {
			method: "POST",
			body: JSON.stringify({ anchorMessageId: args[1] }),
		})) as { ok: boolean; thread?: { id: string } };
		console.log(out.ok ? `fork → ${out.thread?.id}` : "fork 失败");
		break;
	}
	case "mode": {
		// 线程权限模式（产品机制）：default | plan | acceptEdits
		const out = await json(`/api/chat/threads/${args[0]}`, {
			method: "PATCH",
			body: JSON.stringify({ permissionMode: args[1] }),
		});
		console.log(`[mode] → ${args[1]}：${JSON.stringify(out).slice(0, 120)}`);
		break;
	}
	case "leave": {
		await postJson(`/api/chat/threads/${args[0]}/leave`, {});
		console.log("[leave] 已落恢复笔记");
		break;
	}
	case "expand": {
		await postJson(`/api/chat/threads/${args[0]}/resume-action`, {
			action: "resume_fact_opened",
			label: args[1],
		});
		console.log(`[expand] ${args[1]}`);
		break;
	}
	case "bopen": {
		await postJson(`/api/chat/threads/${args[0]}/resume-action`, {
			action: "resume_branch_opened",
			label: args[1],
		});
		console.log(`[bopen] ${args[1]}`);
		break;
	}
	case "dismiss": {
		await postJson(`/api/chat/threads/${args[0]}/resume-note/dismiss`, {});
		console.log("[dismiss] 卡片已关（注入队列同步撤回）");
		break;
	}
	case "view": {
		await openView(args[0]!, null);
		break;
	}
	case "stats": {
		const { spawn } = await import("node:child_process");
		const proc = spawn(process.execPath, [join(ROOT, "packages", "workbench", "src", "index.ts"), "--json", "stats"], {
			cwd: ROOT,
			windowsHide: true,
		});
		let stdout = "";
		proc.stdout.on("data", (chunk) => (stdout += String(chunk)));
		proc.on("exit", () => {
			const start = stdout.indexOf("{");
			const stats = JSON.parse(stdout.slice(start)) as Record<string, unknown>;
			console.log(JSON.stringify(stats.lifecycle ?? stats, null, 2));
		});
		break;
	}
	default:
		console.error(
			"用法：window.ts <open|threads|new|send|fork|leave|expand|bopen|dismiss|view|stats> …",
		);
		process.exit(2);
}
