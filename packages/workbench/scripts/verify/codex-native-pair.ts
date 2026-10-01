/** Optional live native-tool acceptance; inherits an explicitly isolated Codex profile. */
import { join } from "node:path";

export function nativeCasePassed(
	value: Record<string, unknown>,
	stale: boolean,
): boolean {
	const decisions = value.sealDecisions as
		| Array<Record<string, unknown>>
		| undefined;
	return (
		value.measured === true &&
		value.writeMode === "native" &&
		value.case === (stale ? "own-stale" : "own-fresh") &&
		value.staleClaims === (stale ? 1 : 0) &&
		value.readDuringWrite === 0 &&
		value.writeLanded === !stale &&
		value.writeFootprints === (stale ? 0 : 1) &&
		value.sealEventsAfterCodex === 1 &&
		decisions?.length === 1 &&
		decisions[0]?.path === "src/target.ts" &&
		decisions[0]?.writer === value.writerId &&
		decisions[0]?.decision === (stale ? "block" : "pass") &&
		decisions[0]?.hit === stale &&
		decisions[0]?.downgraded === false &&
		value.controlDecision === (stale ? "block" : "pass")
	);
}

if (import.meta.main) {
	const cases: Record<string, unknown>[] = [];
	for (const scenario of ["own-fresh", "own-stale"]) {
		const child = Bun.spawn(
			[
				process.execPath,
				join(import.meta.dir, "codex-write-seal.ts"),
				"--case",
				scenario,
				"--native-write",
				"--json",
			],
			{ stdout: "pipe", stderr: "inherit" },
		);
		const output = await new Response(child.stdout).text();
		const exit = await child.exited;
		try {
			cases.push({ ...JSON.parse(output), instrumentExit: exit });
		} catch {
			cases.push({ case: scenario, measured: false, instrumentExit: exit });
		}
	}
	const passed = cases.filter(
		(value) =>
			value.instrumentExit === 0 &&
			nativeCasePassed(value, value.case === "own-stale"),
	).length;
	console.log(JSON.stringify({ passed, total: 2, cases }, null, 2));
	process.exitCode = passed === 2 ? 0 : 1;
}
