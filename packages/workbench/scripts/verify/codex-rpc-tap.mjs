/** Optional live acceptance instrument; forwards the real CLI and retains local RPC evidence. */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const trace = process.env.WB_VERIFY_TRACE_DIR;
const bin = process.env.WB_CODEX_BIN;
if (!trace || !bin)
	throw new Error("Explicit trace directory and Codex binary required");
mkdirSync(trace, { recursive: true });
const file = join(trace, `rpc-${Date.now()}-${process.pid}.jsonl`);
let seq = 0;
const record = (direction, value) =>
	appendFileSync(
		file,
		`${JSON.stringify({ seq: ++seq, at: new Date().toISOString(), direction, value })}\n`,
	);
const child = spawn(bin, process.argv.slice(2), {
	cwd: process.cwd(),
	env: process.env,
	stdio: ["pipe", "pipe", "pipe"],
	windowsHide: true,
});
record("process", {
	event: "spawn",
	pid: child.pid,
	wrapperPid: process.pid,
	cwd: process.cwd(),
});
function capture(stream, direction, forward) {
	let buffer = "";
	stream.on("data", (chunk) => {
		forward.write(chunk);
		buffer += chunk.toString("utf8");
		let end = buffer.indexOf("\n");
		while (end !== -1) {
			const line = buffer.slice(0, end);
			buffer = buffer.slice(end + 1);
			end = buffer.indexOf("\n");
			try {
				record(direction, JSON.parse(line));
			} catch {
				record(direction, { line });
			}
		}
	});
}
capture(process.stdin, "client", child.stdin);
process.stdin.on("end", () => child.stdin.end());
capture(child.stdout, "server", process.stdout);
capture(child.stderr, "stderr", process.stderr);
child.on("error", (error) => {
	record("process", { event: "error", message: error.message });
	process.exit(2);
});
child.on("exit", (code, signal) => {
	record("process", { event: "exit", code, signal });
	process.exit(code ?? 1);
});
