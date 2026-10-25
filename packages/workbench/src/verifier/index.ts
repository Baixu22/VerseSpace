import type {
	VerificationStrategy,
	VerificationStrategyName,
} from "../types/goal";
import type {
	VerificationEvidence,
	VerificationObject,
} from "../types/verification-evidence";
import { collectVerificationEvidence, reportStamp } from "./evidence-report";
import { executeVerification } from "./execute";
import { type FixedFileOptions, runIsolatedFiles } from "./isolated-files";

export type VerifyResult = (
	| { status: "passed" }
	| { status: "failed"; output: string }
	| { status: "needs_human"; reason: string }
	| { status: "timeout" }
	| { status: "skipped"; reason: string }
) & {
	exitCode?: number | null;
	evidence?: VerificationEvidence;
	object?: VerificationObject;
};

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
function truncateForArchive(output: string): string {
	if (output.length <= MAX_KEPT_OUTPUT_CHARS) {
		return output;
	}
	return `[输出已截断，仅保留末尾 ${MAX_KEPT_OUTPUT_CHARS} 字符]\n${output.slice(
		-MAX_KEPT_OUTPUT_CHARS,
	)}`;
}

/**
 * Timeout precedence: the checkpoint's own `verification.timeout`, then the
 * caller's default (`thresholds.checkpointTimeout`, passed by the runtime),
 * then the module constant. Kept pure so the precedence is testable without
 * spawning a process.
 */
export function resolveTimeoutSeconds(
	verification: VerificationStrategy | undefined,
	defaultTimeoutSeconds?: number,
): number {
	return (
		verification?.timeout ??
		defaultTimeoutSeconds ??
		DEFAULT_VERIFICATION_TIMEOUT_SECONDS
	);
}

/**
 * The Verifier (skeleton module 3): run one checkpoint's verification inside
 * the workspot worktree. Strategy dispatch:
 * - test / type-check / build → spawn the command (or the strategy default),
 *   judge by exit code (`expectedExitCode`, default 0), enforce the timeout
 *   (hard-kill on expiry);
 * - human-review → needs_human, nothing executes;
 * - no strategy → skipped.
 *
 * Timeout precedence: the checkpoint's own `verification.timeout` wins, then
 * the caller's `defaultTimeoutSeconds` (the runtime passes
 * `thresholds.checkpointTimeout`), then `DEFAULT_VERIFICATION_TIMEOUT_SECONDS`.
 * Before P0-2 the middle step did not exist, so `checkpointTimeout` in
 * `workbench.yaml` changed nothing.
 */
export async function runVerification(
	verification: VerificationStrategy | undefined,
	cwd: string,
	defaultTimeoutSeconds?: number,
	fixedOptions: FixedFileOptions = {},
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
	if (verification.evidence?.fixedFiles) {
		return runIsolatedFiles(
			verification,
			cwd,
			resolveTimeoutSeconds(verification, defaultTimeoutSeconds),
			fixedOptions,
		);
	}

	const command =
		verification.command ?? DEFAULT_COMMANDS[verification.strategy];
	const timeoutSeconds = resolveTimeoutSeconds(
		verification,
		defaultTimeoutSeconds,
	);
	const expectedExitCode = verification.expectedExitCode ?? 0;

	const previousStamp = verification.evidence
		? await reportStamp(cwd, verification.evidence.report.path)
		: null;
	const { timedOut, exitCode, output } = await executeVerification(
		command,
		cwd,
		timeoutSeconds,
	);
	const measured = verification.evidence
		? {
				exitCode,
				evidence: await collectVerificationEvidence(
					cwd,
					verification.evidence,
					previousStamp,
				),
			}
		: {};
	if (timedOut) {
		return { status: "timeout", ...measured };
	}
	if (exitCode === expectedExitCode) {
		return { status: "passed", ...measured };
	}
	return { status: "failed", output: truncateForArchive(output), ...measured };
}
