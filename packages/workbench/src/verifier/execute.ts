import { spawnSupervised } from "../supervisor";

/** Shared bounded execution; wait resolves only after the supervised child is gone. */
export function executeVerification(
	command: string | readonly string[],
	cwd: string,
	timeoutSeconds: number,
	env?: NodeJS.ProcessEnv,
): Promise<{ timedOut: boolean; exitCode: number | null; output: string }> {
	return new Promise((resolve) => {
		let output = "";
		const proc = spawnSupervised(command, {
			label: "verify",
			cwd,
			timeoutSeconds,
			env,
			onLine: (line) => {
				output += `${line}\n`;
				if (output.length > 1_000_000) output = output.slice(-500_000);
			},
		});
		void proc.wait().then((outcome) =>
			resolve({
				timedOut: outcome.timedOut,
				exitCode: outcome.exitCode,
				output,
			}),
		);
	});
}
