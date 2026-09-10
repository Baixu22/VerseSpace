import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdir,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";

/**
 * The process supervisor (S0): every agent-adjacent spawn goes through here.
 *
 * - one kill path: tree kill on Windows (`taskkill /T /F`), process-group
 *   kill on POSIX (detached child → negative pid) — killing the direct child
 *   alone orphans cmd.exe shims and whatever they spawned;
 * - argv arrays end to end; a shell is only ever involved as an explicit,
 *   fully-quoted `cmd.exe /d /s /c` wrapper for Windows .cmd/.bat shims
 *   (npm-installed CLIs) — never an uncontrolled `shell: true` string;
 * - pid registry: each supervised process leaves a pid file so a restarted
 *   runtime can reap agents orphaned by a crash (`reapOrphans`);
 * - crash-loop breaker: three abnormal exits within 60s trip the label and
 *   dispatch refuses to spawn it again (OTP-style upgrade abandonment).
 */

export interface SpawnOutcome {
	exitCode: number | null;
	timedOut: boolean;
	killed: boolean;
	error?: string;
}

export interface ProcHandle {
	pid: number | undefined;
	/** Resolves when the process is gone (exit, kill, timeout, or spawn error). */
	wait(): Promise<SpawnOutcome>;
	/** Kill the whole process tree; idempotent. */
	kill(): Promise<void>;
	/**
	 * Streaming input (keepStdinOpen): append one line to the child's stdin.
	 * Rejects once stdin is closed or the process is gone.
	 */
	writeStdin(line: string): void;
	/** Streaming input: close stdin — a stream-json child ends after this. */
	closeStdin(): void;
}

export interface SpawnOptions {
	/** Registry label, e.g. `agent:ws-a` or `chat:<threadId>`. */
	label: string;
	/** Persist pid records here so orphans can be reaped after a crash. */
	registryDir?: string;
	cwd?: string;
	/** Written to stdin (then closed) once the pipe is live. */
	stdin?: string;
	/**
	 * Defer the stdin write until the first stdout chunk proves the pipe is
	 * live (cmd.exe forwards stdin only after the shim has spawned), with a
	 * fallback timer.
	 */
	stdinAfterFirstOutput?: boolean;
	/**
	 * Gate the stdin write on a stdout line predicate — e.g. claude's
	 * stream-json `system/init` line, the reliable "pipe is live" signal on
	 * Windows where an immediate write can be swallowed by the cmd shim.
	 */
	stdinGate?: (line: string) => boolean;
	stdinFallbackMs?: number;
	/**
	 * Streaming-input mode: write `stdin` but do NOT end the stream — the
	 * child stays alive reading further lines via writeStdin/closeStdin.
	 * This is how live-session delivery reaches a claude session between
	 * turns (`--input-format stream-json`).
	 */
	keepStdinOpen?: boolean;
	/** Hard tree-kill once elapsed. */
	timeoutSeconds?: number;
	/** Extra environment (e.g. the per-session messaging socket variables). */
	env?: NodeJS.ProcessEnv;
	/** Streaming line callback — the process's output hits disk immediately. */
	onLine?: (line: string, kind: "out" | "err") => void;
}

/**
 * Quote-aware command-line split. Quotes only wrap a token when they appear
 * at the token boundary (`bun "my tool.js" -x`); quotes INSIDE a token are
 * literal, so JSON arguments like `--settings {"a":"b"}` survive intact.
 */
export function splitCommandLine(line: string): string[] {
	const args: string[] = [];
	let current = "";
	let hasToken = false;
	let tokenQuoted = false;
	let atBoundary = true;
	for (const ch of line) {
		if (!tokenQuoted && /\s/.test(ch)) {
			if (hasToken) {
				args.push(current);
				current = "";
				hasToken = false;
			}
			atBoundary = true;
			continue;
		}
		if (ch === '"') {
			if (atBoundary) {
				tokenQuoted = true; // opening quote: wraps the token
			} else if (tokenQuoted) {
				tokenQuoted = false; // closing quote
			} else {
				current += ch; // inner quote in an unquoted token: literal
			}
			hasToken = true;
			atBoundary = false;
			continue;
		}
		current += ch;
		hasToken = true;
		atBoundary = false;
	}
	if (hasToken) {
		args.push(current);
	}
	return args;
}

interface PidRecord {
	label: string;
	pid: number;
	startedAt: string;
	command: string;
}

function registryFileFor(registryDir: string, label: string, pid: number) {
	const digest = createHash("sha1").update(label).digest("hex").slice(0, 8);
	return join(registryDir, `${digest}-${pid}.json`);
}

export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but is owned by someone else —
		// still alive for our purposes
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Tree kill: the whole tree on Windows, the whole group on POSIX. */
export async function killTree(pid: number): Promise<void> {
	if (process.platform === "win32") {
		await new Promise<void>((resolve) => {
			const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
				stdio: "ignore",
			});
			killer.on("close", () => resolve());
			killer.on("error", () => resolve());
		});
		return;
	}
	try {
		// detached children are their own group leader: negative pid = group
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// already gone
		}
	}
}

/**
 * Kill every process found in the pid registry — a restarted runtime adopts
 * the agents its crashed predecessor left behind and puts them down.
 */
export async function reapOrphans(registryDir: string): Promise<number> {
	let names: string[] = [];
	try {
		names = await readdir(registryDir);
	} catch {
		return 0;
	}
	let reaped = 0;
	for (const name of names.filter((n) => n.endsWith(".json"))) {
		const file = join(registryDir, name);
		try {
			const record = JSON.parse(
				await readFile(file, "utf8"),
			) as Partial<PidRecord>;
			if (
				typeof record.pid === "number" &&
				isProcessAlive(record.pid) &&
				record.pid !== process.pid
			) {
				await killTree(record.pid);
				reaped += 1;
			}
		} catch {
			// unparseable record: just clean it up
		}
		await rm(file, { force: true });
	}
	return reaped;
}

// ── crash-loop breaker (OTP-style upgrade abandonment) ──────────────────

const CRASH_WINDOW_MS = 60_000;
const CRASH_LIMIT = 3;
const crashLog = new Map<string, number[]>();

function crashKey(registryDir: string, label: string): string {
	return `${registryDir}::${label}`;
}

function recordCrash(registryDir: string, label: string): void {
	const key = crashKey(registryDir, label);
	const now = Date.now();
	const stamps = (crashLog.get(key) ?? []).filter(
		(at) => now - at < CRASH_WINDOW_MS,
	);
	stamps.push(now);
	crashLog.set(key, stamps);
}

/** True once the label accumulated `CRASH_LIMIT` abnormal exits in a minute. */
export function crashLoopTripped(registryDir: string, label: string): boolean {
	const key = crashKey(registryDir, label);
	const now = Date.now();
	const stamps = (crashLog.get(key) ?? []).filter(
		(at) => now - at < CRASH_WINDOW_MS,
	);
	crashLog.set(key, stamps);
	return stamps.length >= CRASH_LIMIT;
}

// ── Windows .cmd/.bat shim handling ─────────────────────────────────────

const WINDOWS_PATH_EXTS = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
	.split(";")
	.filter((ext) => ext.length > 0);

async function fileExists(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}

async function resolveWindowsExecutable(
	command: string,
): Promise<string | null> {
	if (/^[a-zA-Z]:[\\/]/.test(command) || command.startsWith("\\\\")) {
		return command; // absolute — use as-is
	}
	const dirs = [
		process.cwd(),
		...(process.env.PATH ?? "").split(";").filter((dir) => dir.length > 0),
	];
	for (const dir of dirs) {
		const bare = join(dir, command);
		if (/\.(exe|cmd|bat|com)$/i.test(command)) {
			if (await fileExists(bare)) {
				return bare;
			}
			continue;
		}
		for (const ext of WINDOWS_PATH_EXTS) {
			const candidate = `${bare}${ext.toLowerCase()}`;
			if (await fileExists(candidate)) {
				return candidate;
			}
		}
	}
	return null;
}

/**
 * Spawn a supervised process. The command line is split into an argv array;
 * on Windows a resolved .cmd/.bat shim is executed through an explicitly
 * quoted `cmd.exe /d /s /c` wrapper (the only place a shell is involved).
 */
export function spawnSupervised(
	commandLine: string,
	options: SpawnOptions,
): ProcHandle {
	const argv = splitCommandLine(commandLine);
	const registryDir = options.registryDir;
	let timedOut = false;
	let killed = false;
	let stdoutBuffer = "";
	let stderrBuffer = "";

	const emitLines = (kind: "out" | "err") => (chunk: Buffer) => {
		const buffer = kind === "out" ? stdoutBuffer : stderrBuffer;
		let pending = buffer + chunk.toString("utf8");
		const lines = pending.split("\n");
		pending = lines.pop() ?? "";
		if (kind === "out") {
			stdoutBuffer = pending;
		} else {
			stderrBuffer = pending;
		}
		for (const line of lines) {
			if (line.trim().length > 0) {
				options.onLine?.(line, kind);
			}
		}
	};

	let resolveWait: (outcome: SpawnOutcome) => void;
	const waited = new Promise<SpawnOutcome>((resolve) => {
		resolveWait = resolve;
	});
	let resolveSpawned: () => void;
	const spawned = new Promise<void>((resolve) => {
		resolveSpawned = resolve;
	});
	let livePid: number | null = null;
	let liveStdin: NodeJS.WritableStream | null = null;
	// notifications written before the child spawned queue up here
	const earlyStdin: string[] = [];
	let settled = false;
	const settle = (outcome: SpawnOutcome) => {
		if (settled) {
			return;
		}
		settled = true;
		resolveSpawned();
		resolveWait(outcome);
	};

	const start = async (): Promise<void> => {
		let file = argv[0] ?? "";
		let args = argv.slice(1);
		// Windows 的 .cmd/.bat 垫片必须经 cmd.exe 执行，且要用「逐字命令行」传参
		// （原因见下方 spawn 处的注释）。
		let verbatimArgs = false;
		if (process.platform === "win32") {
			const resolved = await resolveWindowsExecutable(file);
			if (resolved === null) {
				settle({
					exitCode: null,
					timedOut: false,
					killed: false,
					error: `命令未找到：${file}`,
				});
				return;
			}
			file = resolved;
			if (/\.(cmd|bat)$/i.test(resolved)) {
				// npm shim: cmd.exe must run it; /s normalizes the quoting of
				// the whole command line, which we build from argv pieces.
				// Bare name on purpose: bun's uv_spawn rejects some absolute
				// cmd.exe paths but resolves cmd.exe from PATH reliably.
				const quoted = [resolved, ...args]
					.map((part) => (part.includes(" ") ? `"${part}"` : part))
					.join(" ");
				// 再包一层引号：`cmd /s` 会剥掉最外层的**一对**引号，所以
				// `cmd /c ""C:\a b\x.cmd" arg"` 才是「路径带空格」的标准形式；
				// 只给路径加引号时，cmd 剥掉的是那对引号，路径在空格处断掉。
				args = ["/d", "/s", "/c", `"${quoted}"`];
				file = "cmd.exe";
				verbatimArgs = true;
			}
		}

		// bun's Windows uv_spawn mangles backslash paths in `file` and fails
		// outright on a backslash `cwd` when a custom env is passed; forward
		// slashes resolve fine everywhere Windows APIs accept them
		if (process.platform === "win32") {
			file = file.replace(/\\/g, "/");
		}

		const child = spawn(file, args, {
			cwd: options.cwd?.replace(/\\/g, "/"),
			env: options.env,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
			// cmd.exe 只接受一条命令行，而 Node/bun 默认会把「含空格的单个 argv
			// 元素」包成 "..."，并把元素内部的引号转义成 \"——cmd 不认 \"（它把
			// 引号当分隔符），于是 `cmd /d /s /c "\"C:\...\bun.cmd\" ..."` 里的
			// 第一段变成带反斜杠的字面量，cmd 直接报「不是内部或外部命令」。
			// 路径带空格才会触发：`C:\Users\John Doe\AppData\Roaming\npm\x.cmd`、
			// 或任何装在带空格目录下的垫片（2026-09-11 本机沙箱运行时就是
			// `...\DoubaoWork\User Data\sandbox_runtime\...\node\bun.cmd`，导致
			// 走 CLI 的对话全部「agent 退出码 1」且不产生任何输出）。逐字传递
			// 让我们已经引号化好的那条命令行原样到达 cmd.exe。
			windowsVerbatimArguments: verbatimArgs,
			// POSIX: own process group so a group kill reaches grandchildren
			detached: process.platform !== "win32",
		});
		const pid = child.pid;
		livePid = pid ?? null;
		resolveSpawned();
		const registryWrite =
			pid !== undefined && registryDir
				? mkdir(registryDir, { recursive: true })
						.then(() =>
							writeFile(
								registryFileFor(registryDir, options.label, pid),
								JSON.stringify(
									{
										label: options.label,
										pid,
										startedAt: new Date().toISOString(),
										command: commandLine,
									} satisfies PidRecord,
									null,
									2,
								),
								"utf8",
							),
						)
						.catch(() => {})
				: null;

		let timer: ReturnType<typeof setTimeout> | null = null;
		if (options.timeoutSeconds !== undefined) {
			timer = setTimeout(() => {
				timedOut = true;
				void inner.kill();
			}, options.timeoutSeconds * 1000);
		}

		liveStdin = child.stdin ?? null;
		// stdin: immediate, or after the first output chunk proves the pipe
		// is live (cmd.exe shim quirk), with a fallback timer
		if (options.stdin !== undefined) {
			if (options.stdinGate || options.stdinAfterFirstOutput) {
				let sent = false;
				const send = () => {
					if (sent) {
						return;
					}
					sent = true;
					child.stdin?.write(options.stdin);
					if (!options.keepStdinOpen) {
						child.stdin?.end();
					}
				};
				const gate = options.stdinGate;
				if (gate) {
					child.stdout?.on("data", (chunk: Buffer) => {
						if (sent) {
							return;
						}
						// line-ish check: the gate fires on the first matching line
						for (const line of chunk.toString("utf8").split("\n")) {
							if (gate(line)) {
								send();
								return;
							}
						}
					});
				} else {
					child.stdout?.once("data", send);
				}
				setTimeout(send, options.stdinFallbackMs ?? 500);
			} else {
				child.stdin?.write(options.stdin);
				if (!options.keepStdinOpen) {
					child.stdin?.end();
				}
			}
		}
		// flush anything written before the child existed (early notifications)
		for (const line of earlyStdin.splice(0)) {
			liveStdin?.write(line);
		}

		child.stdout?.on("data", emitLines("out"));
		child.stderr?.on("data", emitLines("err"));

		child.on("close", async (exitCode) => {
			if (timer) {
				clearTimeout(timer);
			}
			liveStdin = null;
			// flush trailing partial lines
			if (stdoutBuffer.trim()) {
				options.onLine?.(stdoutBuffer, "out");
				stdoutBuffer = "";
			}
			if (stderrBuffer.trim()) {
				options.onLine?.(stderrBuffer, "err");
				stderrBuffer = "";
			}
			if (registryDir && registryWrite && pid !== undefined) {
				await registryWrite;
				await rm(registryFileFor(registryDir, options.label, pid), {
					force: true,
				});
			}
			if (!killed && !timedOut && exitCode !== 0 && registryDir) {
				recordCrash(registryDir, options.label);
			}
			settle({ exitCode, timedOut, killed });
		});
		child.on("error", (error) => {
			if (timer) {
				clearTimeout(timer);
			}
			settle({
				exitCode: null,
				timedOut: false,
				killed: false,
				error: String(error),
			});
		});

		inner = {
			pid,
			wait: () => waited,
			kill: async () => {
				if (settled) {
					return;
				}
				killed = true;
				if (livePid !== null) {
					await killTree(livePid);
				}
			},
			writeStdin: (line: string) => {
				if (settled || !liveStdin) {
					throw new Error("stdin 不可写（进程已退出或流已关闭）");
				}
				liveStdin.write(line);
			},
			closeStdin: () => {
				liveStdin?.end();
				liveStdin = null;
			},
		};
	};

	let inner: ProcHandle = {
		pid: undefined,
		wait: () => waited,
		kill: async () => {
			// kill() raced ahead of the async spawn: wait until the child
			// exists (or the spawn failed), then tree-kill it
			killed = true;
			await spawned;
			if (livePid !== null && !settled) {
				await killTree(livePid);
			}
		},
		writeStdin: (line: string) => {
			// child not spawned yet: queue; flushed right after spawn
			earlyStdin.push(line);
		},
		closeStdin: () => {
			earlyStdin.length = 0;
		},
	};
	void start();

	return {
		get pid() {
			return inner.pid;
		},
		wait: () => waited,
		kill: async () => {
			await inner.kill();
		},
		writeStdin: (line: string) => {
			inner.writeStdin(line);
		},
		closeStdin: () => {
			inner.closeStdin();
		},
	};
}
