import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isProcessAlive } from "../supervisor";
import { makeTempWorkbench } from "../test/fixtures";
import { ChatThreads, type RunEvent } from "./threads";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function pollUntil(
	check: () => boolean | Promise<boolean>,
	timeoutMs: number,
	what: string,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await check()) return;
		if (Date.now() > deadline) throw new Error(`等待超时：${what}`);
		await sleep(20);
	}
}

describe("claude 静默挂死收尾（TF-0200 follow-up）", () => {
	test("硬阈值判死 → 树杀子进程、回合以 error 收尾、线程回到 idle", async () => {
		const ws = await makeTempWorkbench();
		const fakeDir = await mkdtemp(join(tmpdir(), "workbench-frozen-agent-"));
		const envKeys = [
			"WORKBENCH_CHAT_COMMAND",
			"WORKBENCH_LIVENESS_STALL_MS",
			"WORKBENCH_LIVENESS_UNRESPONSIVE_MS",
			"WORKBENCH_LIVENESS_KILL_GRACE_MS",
		] as const;
		const saved = new Map(envKeys.map((key) => [key, process.env[key]]));
		// 冻结的 CLI 形状：读着 stdin，永不输出、永不自行退出。09-19 连续三次
		// 复现的挂死就是这个形状——只有树杀能让 wait() 落地。
		await writeFile(
			join(fakeDir, "frozen-agent.js"),
			[
				'const { writeFileSync } = require("node:fs");',
				'writeFileSync(process.argv[1] + ".pid", String(process.pid));',
				"process.stdin.resume();",
				"setInterval(() => {}, 1000);",
			].join("\n"),
			"utf8",
		);
		process.env.WORKBENCH_CHAT_COMMAND = `bun ${join(fakeDir, "frozen-agent.js")}`;
		process.env.WORKBENCH_LIVENESS_STALL_MS = "300";
		process.env.WORKBENCH_LIVENESS_UNRESPONSIVE_MS = "900";
		process.env.WORKBENCH_LIVENESS_KILL_GRACE_MS = "50";
		try {
			const chat = new ChatThreads(ws.bb);
			const thread = await chat.create();
			const emitted: RunEvent[] = [];
			const run = chat
				.run(thread.id, "hi", (event) => {
					emitted.push(structuredClone(event));
				})
				.catch(() => {});

			const pidFile = join(fakeDir, "frozen-agent.js.pid");
			await pollUntil(
				async () => {
					try {
						await readFile(pidFile, "utf8");
						return true;
					} catch {
						return false;
					}
				},
				8_000,
				"假 agent 启动",
			);
			const agentPid = Number(await readFile(pidFile, "utf8"));
			expect(isProcessAlive(agentPid)).toBe(true);
			// 前提：它确实是在跑的回合——否则下面的「回到 idle」会变成空断言
			await pollUntil(
				async () => (await chat.get(thread.id)).status === "running",
				8_000,
				"线程进入 running",
			);

			// 关键判据：回合必须收尾。旧行为是永远挂在 running。
			await Promise.race([
				run,
				sleep(20_000).then(() => {
					throw new Error("回合没有收尾——线程卡在 running");
				}),
			]);

			// 用户看得见：一条 error，而不是静默消失
			expect(emitted.some((event) => event.type === "error")).toBe(true);
			// 死法如实记录：judged_silent（判死且已行动），不是无动作的 unresponsive
			const liveness = await ws.bb.events.query({ type: "agent_liveness" });
			const kinds = liveness.map(
				(event) => (event.payload as { kind?: string }).kind,
			);
			expect(kinds).toContain("judged_silent");
			expect(kinds).not.toContain("unresponsive");
			// 子进程真的消失——树杀落在真进程上
			await pollUntil(
				() => {
					try {
						process.kill(agentPid, 0);
						return false;
					} catch {
						return true;
					}
				},
				8_000,
				"子进程被树杀",
			);
			// 线程回到 idle，不卡 running
			await pollUntil(
				async () => (await chat.get(thread.id)).status !== "running",
				8_000,
				"线程退出 running",
			);
			expect((await chat.get(thread.id)).status).toBe("idle");
		} finally {
			for (const key of envKeys) {
				const value = saved.get(key);
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			await rm(fakeDir, { recursive: true, force: true });
			await ws.cleanup();
		}
	}, 40_000);
});
