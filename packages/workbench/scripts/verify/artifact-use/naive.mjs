/** Strong native baseline: explicit receipt, fixed files, exact report, rerun at consumption. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digest } from "./judge.mjs";

export function runNaive(spec) {
	const cwd = mkdtempSync(join(tmpdir(), "artifact-naive-"));
	writeFileSync(join(cwd, "api.txt"), spec.input);
	const returned = readFileSync(join(cwd, "api.txt"));
	const api =
		spec.after ?? spec.beforeCheck ?? spec.beforeCapture ?? spec.input;
	writeFileSync(join(cwd, "api.txt"), api);
	writeFileSync(join(cwd, "consumer.txt"), spec.artifact);
	writeFileSync(join(cwd, "case.json"), JSON.stringify(spec));
	writeFileSync(
		join(cwd, "check.cjs"),
		readFileSync(
			new URL("../../../fixtures/artifact-use/check.cjs", import.meta.url),
		),
	);
	const execute = () =>
		spawnSync(process.execPath, ["check.cjs"], {
			cwd,
			encoding: "utf8",
			env: { ...process.env, ARTIFACT_FIXED_COPY: "1" },
			timeout: 60000,
			windowsHide: true,
		});
	const repeat = spec.repeatConsumes ?? 1;
	let run;
	for (let i = 0; i < repeat; i++) {
		run = execute();
		if (run.error || run.status === null)
			throw run.error ?? new Error("native check did not complete");
	}
	if (run.error || run.status === null)
		throw run.error ?? new Error("native check did not complete");
	let complete = false;
	try {
		const report = JSON.parse(readFileSync(join(cwd, "report.json"), "utf8"));
		const tests = report.testResults.flatMap((r) => r.assertionResults);
		complete =
			report.success === true &&
			tests.length === 2 &&
			new Set(tests.map((t) => t.fullName)).size === 2 &&
			["contract input", "contract consumer"].every((n) =>
				tests.some((t) => t.fullName === n && t.status === "passed"),
			) &&
			report.numTotalTests === 2 &&
			report.numPassedTests === 2 &&
			report.numFailedTests === 0 &&
			report.numPendingTests === 0;
	} catch {
		/* Missing/broken report cannot authorize consumption. */
	}
	return {
		id: spec.id,
		consumable: run.status === 0 && complete && !spec.targetAdvance,
		originInput: digest(returned),
		observedInput: spec.toolCoverage === "full" ? digest(returned) : null,
		targetChecked: false,
		executions: repeat,
		repeatedChecks: repeat,
		cwd,
	};
}
