/**
 * TF-0140 · `--live`：真跑一次 fork，命令行与 threads.ts 逐字一致。
 *
 * 关键时序：`system/init` 行与会话文件落盘都发生在第一次 API 调用之前，
 * 所以 Q1（resume 能否接上）与 Q3（前缀是否逐字复刻）在未登录的机器上同样可测；
 * 只有 Q2 需要真实计费轮次，未登录时明确标 unmeasured，不拿零值冒充观测。
 */

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	commonPrefix,
	findSessionFile,
	loadSession,
	toolIds,
} from "./sessions";

/** threads.ts 的 chat 命令原型；live 模式必须和它逐字一致才算测到同一条路径。 */
const CHAT_ARGS = [
	"-p",
	"--verbose",
	"--output-format",
	"stream-json",
	"--include-partial-messages",
	"--input-format",
	"stream-json",
];

interface RunOut {
	sessionId: string | null;
	authFailed: boolean;
	resultText: string;
	lines: number;
}

async function runClaude(
	cwd: string,
	extra: string[],
	prompt: string,
): Promise<RunOut> {
	const proc = Bun.spawn(["claude", ...CHAT_ARGS, ...extra], {
		cwd,
		stdin: new TextEncoder().encode(
			`${JSON.stringify({
				type: "user",
				message: { role: "user", content: prompt },
			})}\n`,
		),
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = await new Response(proc.stdout).text();
	await proc.exited;
	const out: RunOut = {
		sessionId: null,
		authFailed: false,
		resultText: "",
		lines: 0,
	};
	for (const line of stdout.split("\n")) {
		if (!line.trim()) continue;
		out.lines += 1;
		let d: Record<string, unknown>;
		try {
			d = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (d.subtype === "init" && typeof d.session_id === "string")
			out.sessionId = d.session_id;
		if (d.error === "authentication_failed") out.authFailed = true;
		if (d.type === "result" && typeof d.result === "string") {
			out.resultText = d.result;
			if (/not logged in/i.test(d.result)) out.authFailed = true;
		}
	}
	return out;
}

export async function live(): Promise<void> {
	const scratch = join(tmpdir(), `wb-fork-${Date.now()}`);
	await mkdir(scratch, { recursive: true });
	await writeFile(join(scratch, "secret.txt"), "MARKER=ZEPHYR-4471\n");
	const sourceId = randomUUID();
	console.log(`scratch: ${scratch}`);

	const src = await runClaude(
		scratch,
		["--session-id", sourceId, "--allowedTools", "Read"],
		"Read secret.txt and reply with only the MARKER value.",
	);
	const fork = await runClaude(
		scratch,
		["--resume", sourceId, "--fork-session", "--allowedTools", "Read"],
		"What MARKER value did you read? Reply with only the value or UNKNOWN.",
	);

	console.log("\n== Q1 · resume + fork-session 能否接上 stream-json 会话 ==");
	console.log(`  源 session id（--session-id 铸出）: ${src.sessionId}`);
	console.log(`  fork session id（init 行回报）    : ${fork.sessionId}`);
	const resumed = fork.sessionId !== null && fork.sessionId !== sourceId;
	console.log(
		`  判据：resume 未报「no conversation found」且 init 回报新 id → ${
			resumed ? "成立" : "不成立"
		}`,
	);

	const srcPath = await findSessionFile(sourceId);
	const forkPath = fork.sessionId
		? await findSessionFile(fork.sessionId)
		: null;
	console.log("\n== Q3 · 前缀复刻与 tool_use_id 命名空间 ==");
	if (!srcPath || !forkPath) {
		console.log("  两个会话文件没同时落盘，Q3 本轮 unmeasured");
	} else {
		const a = await loadSession(srcPath);
		const b = await loadSession(forkPath);
		const n = commonPrefix(a, b);
		const ids = Array.from({ length: n }, (_, k) => toolIds(a[k]!)).flat();
		console.log(
			`  源 ${a.length} 条 / fork ${b.length} 条，逐字共享前缀 ${n} 条`,
		);
		console.log(`  共享前缀内 tool id ${ids.length} 条`);
		console.log(
			`  判据：fork 文件复刻源 uuid（只改写 sessionId）→ ${n > 0 ? "成立" : "不成立"}`,
		);
	}

	console.log("\n== Q2 · 前缀 KV 命中 ==");
	if (src.authFailed || fork.authFailed) {
		console.log(
			`  unmeasured：本机 claude 未登录（${src.resultText || fork.resultText}）。`,
		);
		console.log(
			"  Q1/Q3 不受影响：init 行与前缀复刻都发生在第一次 API 调用之前。",
		);
	} else {
		console.log(
			"  见 --scan 的 forkFirstUsage / gapMinutes（缓存 TTL 是混淆项）",
		);
	}
}
