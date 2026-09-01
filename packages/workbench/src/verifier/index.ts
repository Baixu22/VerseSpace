import { spawnSupervised } from "../supervisor";
import type {
	VerificationStrategy,
	VerificationStrategyName,
} from "../types/goal";

export type VerifyResult =
	| { status: "passed" }
	| { status: "failed"; output: string }
	| { status: "needs_human"; reason: string }
	| { status: "timeout" }
	| { status: "skipped"; reason: string };

export const DEFAULT_VERIFICATION_TIMEOUT_SECONDS = 300;

/** Per-strategy fallbacks; a checkpoint's `command` always overrides these. */
export const DEFAULT_COMMANDS: Record<
	Exclude<VerificationStrategyName, "human-review">,
	string
> = {
	test: "bun test",
	"type-check": "bunx tsc --noEmit",
	build: "bun run build",
};

/** Failure output archived into the checkpoint keeps only the tail. */
const MAX_KEPT_OUTPUT_CHARS = 20_000;
/** Hard cap on accumulated output so a spewing process cannot eat memory. */
const MAX_BUFFER_CHARS = 1_000_000;

function truncateForArchive(output: string): string {
	if (output.length <= MAX_KEPT_OUTPUT_CHARS) {
		return output;
	}
	return `[输出已截断，仅保留末尾 ${MAX_KEPT_OUTPUT_CHARS} 字符]\n${output.slice(
		-MAX_KEPT_OUTPUT_CHARS,
	)}`;
}

function execute(
	command: string,
	cwd: string,
	timeoutSeconds: number,
): Promise<{
	timedOut: boolean;
	exitCode: number | null;
	output: string;
}> {
	// the supervisor owns the spawn: argv-array (no shell:true), tree kill on
	// timeout, and a bounded output buffer so a spewing process cannot eat
	// memory
	return new Promise((resolve) => {
		let output = "";
		const append = (chunk: string) => {
			output += chunk;
			if (output.length > MAX_BUFFER_CHARS) {
				output = output.slice(-MAX_BUFFER_CHARS / 2);
			}
		};
		const proc = spawnSupervised(command, {
			label: "verify",
			cwd,
			timeoutSeconds,
			onLine: (line, _kind) =>
				append(`${line}
`),
		});
		void proc.wait().then((outcome) => {
			resolve({
				timedOut: outcome.timedOut,
				exitCode: outcome.exitCode,
				output,
			});
		});
	});
}

/**
 * The Verifier (skeleton module 3): run one checkpoint's verification inside
 * the workspot worktree. Strategy dispatch:
 * - test / type-check / build → spawn the command (or the strategy default),
 *   judge by exit code (`expectedExitCode`, default 0), enforce the timeout
 *   (default 5 minutes, hard-kill on expiry);
 * - human-review → needs_human, nothing executes;
 * - no strategy → skipped.
 */
export async function runVerification(
	verification: VerificationStrategy | undefined,
	cwd: string,
): Promise<VerifyResult> {
	if (!verification) {
		return {
			status: "skipped",
			reason: "该 checkpoint 没有 verification 策略",
		};
	}
	if (verification.strategy === "human-review") {
		return { status: "needs_human", reason: "该 checkpoint 要求人工审查" };
	}

	const command =
		verification.command ?? DEFAULT_COMMANDS[verification.strategy];
	const timeoutSeconds =
		verification.timeout ?? DEFAULT_VERIFICATION_TIMEOUT_SECONDS;
	const expectedExitCode = verification.expectedExitCode ?? 0;

	const { timedOut, exitCode, output } = await execute(
		command,
		cwd,
		timeoutSeconds,
	);
	if (timedOut) {
		return { status: "timeout" };
	}
	if (exitCode === expectedExitCode) {
		return { status: "passed" };
	}
	return { status: "failed", output: truncateForArchive(output) };
}
