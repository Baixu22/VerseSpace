import { readFile, writeFile } from "node:fs/promises";
import { baselineSha, frozenSource } from "./frozen-source.mjs";
import { digest, fixture, fixtureDigest, judge } from "./judge.mjs";
import { runNaive } from "./naive.mjs";

const started = Date.now();
if (process.argv.includes("--frozen-baseline"))
	process.env.MOAT_SOURCE_ROOT = frozenSource();
const { runWorkbench } = await import("./workbench");

const cases = fixture.cases.filter(
	(row: { partition?: string }) => row.partition !== "heldout",
);
const naive = cases.map(runNaive);
const workbench = [];
for (const spec of cases) workbench.push(await runWorkbench(spec));
const result = {
	fixtureDigest,
	judgeDigest: digest(await readFile(new URL("./judge.mjs", import.meta.url))),
	cases: cases.length,
	heldout: fixture.cases.length - cases.length,
	naive: judge(naive, cases),
	workbench: judge(workbench, cases),
	observations: { naive, workbench },
	subject: process.argv.includes("--frozen-baseline")
		? baselineSha
		: "current-source",
	elapsedMs: Date.now() - started,
};
const outputIndex = process.argv.indexOf("--output");
if (outputIndex >= 0)
	await writeFile(
		process.argv[outputIndex + 1]!,
		JSON.stringify(result, null, 2),
	);
console.log(JSON.stringify({ ...result, observations: undefined }, null, 2));
// The baseline instrument succeeds when measured, even if the old product has gaps.
if (result.naive.errors || result.naive.unknown) process.exitCode = 1;
