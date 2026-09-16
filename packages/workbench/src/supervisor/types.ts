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
