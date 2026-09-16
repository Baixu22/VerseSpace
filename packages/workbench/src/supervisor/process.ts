import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { resolveSpawnCommand, splitCommandLine } from "./argv";
import { recordCrash } from "./crash";
import { killTree, registerProcess, registryFileFor } from "./registry";
import type { ProcHandle, SpawnOptions, SpawnOutcome } from "./types";

/**
 * Spawn a supervised process. The command line is split into an argv array;
 * on Windows a resolved .cmd/.bat shim is executed through an explicitly
 * quoted `cmd.exe /d /s /c` wrapper (the only place a shell is involved).
 */
export function spawnSupervised(
	commandLine: string | readonly string[],
	options: SpawnOptions,
): ProcHandle {
	const argv =
		typeof commandLine === "string"
			? splitCommandLine(commandLine)
			: [...commandLine];
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
		const command = await resolveSpawnCommand(argv);
		if (!command) {
			settle({
				exitCode: null,
				timedOut: false,
				killed: false,
				error: `命令未找到：${argv[0] ?? ""}`,
			});
			return;
		}
		const { file, args, verbatimArgs } = command;

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
				? registerProcess(registryDir, options.label, pid, commandLine)
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
