/** Optional live native-tool acceptance; inherits an explicitly isolated Codex profile. */
import { join } from "node:path";

export function nativeCasePassed(
	value: Record<string, unknown>,
	stale: boolean,
	protectedArea = false,
): boolean {
	const blocked = stale || protectedArea;
	const decisions = value.sealDecisions as
		| Array<Record<string, unknown>>
		| undefined;
	return (
		value.measured === true &&
		value.writeMode === "native" &&
		typeof value.writerId === "string" &&
		value.writerId.length > 0 &&
		value.case === (stale ? "own-stale" : "own-fresh") &&
		value.staleClaims === (stale ? 1 : 0) &&
		value.readDuringWrite === 0 &&
		value.finalThreadState === "idle" &&
		value.writeLanded === !blocked &&
		value.writeFootprints === (blocked ? 0 : 1) &&
		value.sealEventsAfterCodex === 1 &&
		decisions?.length === 1 &&
		decisions[0]?.path === "src/target.ts" &&
		decisions[0]?.writer === value.writerId &&
		decisions[0]?.decision === (blocked ? "block" : "pass") &&
		decisions[0]?.hit === blocked &&
		decisions[0]?.downgraded === false &&
		value.controlDecision === (blocked ? "block" : "pass") &&
		(protectedArea
			? value.readonlyArea === true && decisions[0]?.kind === "readonly_area"
			: value.readonlyArea !== true)
	);
}

/** A measured unsealed write is different from a turn that could not be measured. */
export function unsealedNativeCaseObserved(
	value: Record<string, unknown>,
	stale: boolean,
): boolean {
	return (
		value.measured === true &&
		value.writeMode === "native" &&
		typeof value.writerId === "string" &&
		value.writerId.length > 0 &&
		value.case === (stale ? "own-stale" : "own-fresh") &&
		value.staleClaims === (stale ? 1 : 0) &&
		value.readDuringWrite === 0 &&
		value.finalThreadState === "idle" &&
		value.readonlyArea !== true &&
		value.writeLanded === true &&
		value.writeFootprints === 1 &&
		value.sealEventsAfterCodex === 0 &&
		Array.isArray(value.sealDecisions) &&
		value.sealDecisions.length === 0 &&
		value.controlDecision === (stale ? "block" : "pass")
	);
}

if (import.meta.main) {
	const protectedArea = process.argv.includes("--readonly-area");
	const expectUnsealed = process.argv.includes("--expect-unsealed");
	if (protectedArea && expectUnsealed) {
		console.error(
			"readonly and unsealed expectations require separate profiles",
		);
		process.exit(2);
	}
	const scenarios = protectedArea ? ["own-fresh"] : ["own-fresh", "own-stale"];
	const cases: Record<string, unknown>[] = [];
	for (const scenario of scenarios) {
		const child = Bun.spawn(
			[
				process.execPath,
				join(import.meta.dir, "codex-write-seal.ts"),
				"--case",
				scenario,
				"--native-write",
				"--json",
				...(protectedArea ? ["--readonly-area"] : []),
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
			nativeCasePassed(value, value.case === "own-stale", protectedArea),
	).length;
	const measured = cases.every(
		(value) => value.instrumentExit === 0 && value.measured === true,
	);
	const unsealed = cases.filter((value) =>
		unsealedNativeCaseObserved(value, value.case === "own-stale"),
	).length;
	console.log(
		JSON.stringify(
			{ measured, passed, unsealed, total: scenarios.length, cases },
			null,
			2,
		),
	);
	process.exitCode = !measured
		? 2
		: (expectUnsealed ? unsealed : passed) === scenarios.length
			? 0
			: 1;
}
