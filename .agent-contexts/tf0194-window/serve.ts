/**
 * TF-0194 观察窗服务：在真实仓库（D:\helmor-main，真实黑板 .workbench）上
 * 起 workbench ui。不覆盖 WORKBENCH_CHAT_COMMAND——聊天车道用默认的
 * 真实 claude CLI。port/token 写入 server.json 供 window.ts 驱动器读取。
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");
const ENTRY = join(ROOT, "packages", "workbench", "src", "index.ts");
const STATE = join(import.meta.dir, "server.json");

const freePort = (): Promise<number> =>
	new Promise((resolvePort, reject) => {
		const server = net.createServer();
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			server.close(() => (port ? resolvePort(port) : reject(new Error("no port"))));
		});
		server.on("error", reject);
	});

const port = await freePort();
const proc = spawn(process.execPath, [ENTRY, "ui", "--port", String(port), "--no-open"], {
	cwd: ROOT,
	windowsHide: true,
	env: { ...process.env },
});
let stderr = "";
proc.stderr?.on("data", (chunk) => {
	stderr += String(chunk);
	process.stderr.write(`[ui] ${String(chunk)}`);
});
proc.stdout?.on("data", (chunk) => process.stdout.write(`[ui] ${String(chunk)}`));

const token = await (async () => {
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		if (proc.exitCode !== null) {
			throw new Error(`ui 服务提前退出：${stderr.slice(0, 400)}`);
		}
		try {
			const res = await fetch(`http://127.0.0.1:${port}/api/bootstrap`);
			if (res.ok) {
				const body = (await res.json()) as { token: string };
				return body.token;
			}
		} catch {
			// not up yet
		}
		await new Promise((r) => setTimeout(r, 300));
	}
	throw new Error("ui 服务 20s 未就绪");
})();

await mkdir(import.meta.dir, { recursive: true });
await writeFile(
	STATE,
	JSON.stringify({ port, token, pid: proc.pid, startedAt: new Date().toISOString() }, null, 2),
);
console.log(`[window] ui 服务就绪：port=${port} pid=${proc.pid}`);
proc.on("exit", async (code, signal) => {
	console.log(`[window] ui 服务退出：code=${code} signal=${signal} @ ${new Date().toISOString()}`);
	try {
		await import("node:fs/promises").then((fs) => fs.rm(STATE, { force: true }));
	} catch {
		// best effort
	}
});
