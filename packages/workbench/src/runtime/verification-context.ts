import { realpath } from "node:fs/promises";
import { hashFile } from "../hash";
import type { VerificationContext } from "../types/checkpoint";
import type { VerificationStrategy } from "../types/goal";
import { DEFAULT_COMMANDS, resolveTimeoutSeconds } from "../verifier";
import { evidenceFilePath } from "../verifier/evidence-report";
import { fixedNodeRunner } from "../verifier/isolated-files";

/** Resolve the same defaults as the verifier; failed cwd resolution is unknown. */
export async function captureVerificationContext(
	verification: VerificationStrategy | undefined,
	cwd: string,
	defaultTimeoutSeconds: number | undefined,
	authority: VerificationContext["authority"],
): Promise<VerificationContext | undefined> {
	try {
		const canonical = await realpath(cwd);
		const evidence = verification?.evidence;
		const inputs: Record<string, string> = {};
		if (evidence) {
			for (const path of evidence.inputs)
				inputs[path] = await hashFile(await evidenceFilePath(canonical, path));
			if (evidence.fixedFiles)
				inputs[evidence.fixedFiles.script] = await hashFile(
					await evidenceFilePath(canonical, evidence.fixedFiles.script),
				);
		}
		const fixedRunner = evidence?.fixedFiles
			? (await fixedNodeRunner(canonical)).runner
			: undefined;
		return {
			cwd: canonical,
			strategy: verification?.strategy ?? null,
			command:
				!verification || verification.strategy === "human-review"
					? null
					: evidence?.fixedFiles
						? `node-offline-files-v1:${evidence.fixedFiles.script}`
						: (verification.command ?? DEFAULT_COMMANDS[verification.strategy]),
			expectedExitCode: verification?.expectedExitCode ?? 0,
			timeoutSeconds: evidence?.fixedFiles
				? Math.min(
						resolveTimeoutSeconds(verification, defaultTimeoutSeconds),
						60,
					)
				: resolveTimeoutSeconds(verification, defaultTimeoutSeconds),
			authority,
			...(fixedRunner ? { fixedRunner } : {}),
			...(evidence
				? {
						evidence: {
							declared: evidence,
							inputs,
							runner: {
								node: process.versions.node,
								bun: process.versions.bun ?? null,
								platform: process.platform,
								arch: process.arch,
							},
						},
					}
				: {}),
		};
	} catch {
		return undefined;
	}
}
