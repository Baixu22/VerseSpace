/**
 * 单步自包含执行器：起 ui 服务 → 执行一条 window.ts 命令 → 关服务。
 * 本环境的后台进程会在调用/轮次边界被回收（窗口日志「运行备注」有记录），
 * 所以服务只在一次 Bash 调用内存活——每步都自带完整生命周期。
 *
 * 用法：bun step.ts <window.ts 的参数...>
 */
import { spawn } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
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
const server = spawn(process.execPath, [ENTRY, "ui", "--port", String(port), "--no-open"], {
	cwd: ROOT,
	windowsHide: true,
	env: { ...process.env },
});
server.stderr?.on("data", (chunk) => process.stderr.write(`[ui] ${String(chunk)}`));

const token = await (async () => {
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
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
await writeFile(STATE, JSON.stringify({ port, token, startedAt: new Date().toISOString() }));

const exitCode = await new Promise<number>((done) => {
	const child = spawn(process.execPath, [join(import.meta.dir, "window.ts"), ...process.argv.slice(2)], {
		cwd: ROOT,
		windowsHide: true,
		stdio: "inherit",
		env: { ...process.env, NO_PROXY: "127.0.0.1,localhost,::1" },
	});
	child.on("exit", (code) => done(code ?? 1));
	child.on("error", (error) => {
		console.error(error);
		done(1);
	});
});

server.kill();
await rm(STATE, { force: true }).catch(() => {});
process.exit(exitCode);
