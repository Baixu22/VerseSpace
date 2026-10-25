import { execFileSync, spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { frozenSource } from "./frozen-source.mjs";
import { digest, fixture, fixtureDigest, judge } from "./judge.mjs";

const final = process.argv.includes("--final");
const requested = process.argv.indexOf("--groups");
const groups =
	requested < 0
		? [
				"naive",
				"old",
				"enhanced",
				"without-return-origin",
				"without-fixed-copy",
				"without-use-guard",
				"without-target-range",
			]
		: process.argv[requested + 1]!.split(",");
const planFile = new URL(
	"../../../fixtures/artifact-use/replay-plan.json",
	import.meta.url,
);
const planBytes = await readFile(planFile);
const freeze = JSON.parse(
	await readFile(
		new URL(
			"../../../fixtures/artifact-use/replay-plan-freeze.json",
			import.meta.url,
		),
		"utf8",
	),
);
const plan = JSON.parse(planBytes.toString());
if (
	digest(planBytes) !== freeze.planDigest ||
	fixtureDigest !== plan.fixtureDigest ||
	digest(await readFile(new URL("./judge.mjs", import.meta.url))) !==
		plan.judgeDigest
)
	throw new Error("frozen replay plan/fixture/judge drift");
if (
	groups.some(
		(id) => !plan.groups.some((group: { id: string }) => group.id === id),
	)
)
	throw new Error("unknown replay group");
const repo = fileURLToPath(new URL("../../../../../", import.meta.url));
const subject = execFileSync("git", ["rev-parse", "HEAD"], {
	cwd: repo,
	encoding: "utf8",
}).trim();
const oldSource = groups.includes("old") ? frozenSource() : undefined;
const cases = fixture.cases.filter(
	(item: { partition?: string }) => final || item.partition !== "heldout",
);
const observations: Record<string, Record<string, unknown>[]> = {};
const results: Record<string, ReturnType<typeof judge>> = {};
const failures: Array<{ group: string; caseId: string; reason: string }> = [];
const started = performance.now();
for (const group of groups) {
	const rows: Record<string, unknown>[] = [];
	for (const spec of cases) {
		const begin = performance.now();
		const run = spawnSync(
			process.execPath,
			[fileURLToPath(new URL("./probe.ts", import.meta.url)), group, spec.id],
			{
				cwd: repo,
				encoding: "utf8",
				maxBuffer: 2_000_000,
				timeout: fixture.budget.maxCaseSeconds * 1000,
				windowsHide: true,
				env: {
					...process.env,
					NO_PROXY: "127.0.0.1,localhost,::1",
					...(oldSource ? { MOAT_SOURCE_ROOT: oldSource } : {}),
				},
			},
		);
		let row: Record<string, unknown>;
		try {
			if (run.status !== 0 || run.error)
				throw new Error(
					`exit=${run.status} signal=${run.signal} ${run.error?.message ?? run.stderr?.slice(-1000)}`,
				);
			row = JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1)!);
			if (row.id !== spec.id) throw new Error("observation identity mismatch");
		} catch (error) {
			failures.push({ group, caseId: spec.id, reason: String(error) });
			row = {
				id: spec.id,
				consumable: null,
				originInput: null,
				observedInput: null,
				targetChecked: null,
				repeatedChecks: null,
			};
		}
		rows.push({
			...row,
			actualExit: run.status,
			wallMs: performance.now() - begin,
			timedOut: run.error?.code === "ETIMEDOUT",
		});
		console.log(
			JSON.stringify({
				group,
				caseId: spec.id,
				actualExit: run.status,
				wallMs: rows.at(-1)!.wallMs,
			}),
		);
	}
	observations[group] = rows;
	results[group] = judge(rows, cases);
}
const output = {
	schemaVersion: 1,
	partition: final ? "all-including-heldout" : "development-only",
	subject,
	frozenBaseline: plan.frozenBaseline,
	planDigest: freeze.planDigest,
	fixtureDigest,
	judgeDigest: plan.judgeDigest,
	cases: cases.length,
	reserved: fixture.cases.length - cases.length,
	groups: results,
	expected: cases.map((spec: { id: string; expected: unknown }) => ({
		id: spec.id,
		expected: spec.expected,
	})),
	observations,
	failures,
	modelTokens: null,
	modelCost: null,
	elapsedMs: performance.now() - started,
	limitations:
		"Controlled Windows file workflow; no provider usage, natural-user productivity or market moat measurement",
};
const index = process.argv.indexOf("--output");
if (index >= 0)
	await writeFile(process.argv[index + 1]!, JSON.stringify(output, null, 2));
console.log(JSON.stringify({ ...output, observations: undefined }, null, 2));
if (
	failures.length ||
	["naive", "enhanced"].some(
		(group) =>
			results[group] && (results[group].errors || results[group].unknown),
	)
)
	process.exitCode = 1;
