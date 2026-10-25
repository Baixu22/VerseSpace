import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { cpus, freemem, tmpdir, totalmem } from "node:os";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { exportArtifactManifest } from "../../../../src/artifacts/manifest";
import {
	assessArtifactManifest,
	decodeArtifactManifest,
	stableManifestJson,
} from "../../../../src/artifacts/manifest-codec";
import { listArtifactReviews } from "../../../../src/artifacts/status";
import { checkArtifactUse } from "../../../../src/artifacts/use-guard";
import { captureReturnedInput } from "../../../../src/blackboard/footprint-sample";
import { acquireRunLock } from "../../../../src/fs/lockfile";
import { verifyCheckpoint } from "../../../../src/runtime/verify-checkpoint";
import { runNaive } from "../naive.mjs";
import {
	ARTIFACT_ID,
	CHECKPOINT_ID,
	type CostFixture,
	makeCostFixture,
} from "./fixture";
import { compareTiming, distribution, overBudget } from "./stats";

type Plan = {
	schemaVersion: number;
	timing: { warmups: number; samples: number; maxSampleMs: number };
	ledgerRows: number[];
	repeatConsumptions: number;
	budget: {
		maxChecksForFourUnchangedConsumptions: number;
		maxVerificationRequests: number;
		falseCurrent: number;
		unknown: number;
		maxTimedSampleMs: number;
	};
};
type Timed<T> = {
	wallMs: number;
	heapDeltaBytes: number;
	rssBytes: number;
} & T;

const here = fileURLToPath(new URL(".", import.meta.url));
const repo = resolve(here, "../../../../../");
const digest = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");
const planBytes = await readFile(
	new URL("../../../../fixtures/artifact-use/cost-plan.json", import.meta.url),
);
const plan = JSON.parse(planBytes.toString()) as Plan;
const freeze = JSON.parse(
	await readFile(
		new URL(
			"../../../../fixtures/artifact-use/cost-freeze.json",
			import.meta.url,
		),
		"utf8",
	),
);
if (digest(planBytes) !== freeze.planDigest) throw new Error("cost plan drift");
if (
	plan.timing.warmups !== 1 ||
	plan.timing.samples !== 5 ||
	plan.timing.maxSampleMs !== 60_000 ||
	plan.repeatConsumptions !== 4 ||
	plan.ledgerRows.join(",") !== "1000,10000,50000"
)
	throw new Error("cost plan no longer matches the frozen definition");

function collectGarbage() {
	if (typeof Bun !== "undefined" && typeof Bun.gc === "function") Bun.gc(true);
}

async function sampleSeries<T>(
	action: (iteration: number) => Promise<T>,
): Promise<{
	cold: Timed<T>;
	hot: Timed<T>[];
	hotWallMs: ReturnType<typeof distribution>;
	heapDeltaBytes: ReturnType<typeof distribution>;
	rssBytes: ReturnType<typeof distribution>;
	overBudgetMs: number[];
}> {
	const rows: Timed<T>[] = [];
	for (let i = 0; i < plan.timing.warmups + plan.timing.samples; i++) {
		collectGarbage();
		const heapBefore = process.memoryUsage().heapUsed;
		const started = performance.now();
		const value = await action(i);
		rows.push({
			...value,
			wallMs: performance.now() - started,
			heapDeltaBytes: process.memoryUsage().heapUsed - heapBefore,
			rssBytes: process.memoryUsage().rss,
		});
	}
	const hot = rows.slice(plan.timing.warmups);
	return {
		cold: rows[0]!,
		hot,
		hotWallMs: distribution(hot.map((row) => row.wallMs)),
		heapDeltaBytes: distribution(hot.map((row) => row.heapDeltaBytes)),
		rssBytes: distribution(hot.map((row) => row.rssBytes)),
		overBudgetMs: overBudget(
			rows.map((row) => row.wallMs),
			plan.timing.maxSampleMs,
		),
	};
}

async function removeNaiveDirectory(path: string) {
	const target = resolve(path);
	const base = resolve(tmpdir());
	if (!target.startsWith(`${base}${sep}`))
		throw new Error("refusing to remove a non-temp native fixture");
	await rm(target, { recursive: true, force: true, maxRetries: 5 });
}

async function measureEnhanced(rows: number) {
	return sampleSeries(async () => {
		const fixture = await makeCostFixture(rows, false);
		try {
			await verifyCheckpoint(fixture.bb, CHECKPOINT_ID, []);
			const root = (await fixture.bb.checkpoints.scanZone("verified")).find(
				(entry) => entry.id === CHECKPOINT_ID,
			);
			if (!root) throw new Error("enhanced fixture did not verify");
			const guardTimesMs: number[] = [];
			const reasons: string[] = [];
			let consumable = true;
			for (let i = 0; i < plan.repeatConsumptions; i++) {
				const lock = await acquireRunLock(fixture.bb.paths.root);
				if (!lock.acquired) throw new Error("run lock unavailable");
				const started = performance.now();
				try {
					const decision = await checkArtifactUse(fixture.bb, root);
					consumable &&= decision.ok;
					if (!decision.ok) reasons.push(decision.reason);
				} finally {
					guardTimesMs.push(performance.now() - started);
					await lock.release();
				}
			}
			const requests = (
				await fixture.bb.events.query({ type: "request_verification" })
			).length;
			const object = root.verificationResult?.object;
			return {
				consumable,
				guardQueries: guardTimesMs.length,
				guardTimesMs,
				verificationRequests: requests,
				copyMs: object?.copyMs ?? null,
				copyBytes: object?.copyBytes ?? null,
				runMs: object?.runMs ?? null,
				reviewStatus:
					(await listArtifactReviews(fixture.bb))[0]?.status ?? null,
				reasons,
				eventsBytes: (await stat(fixture.bb.paths.eventsFile)).size,
			};
		} finally {
			await fixture.cleanup();
		}
	});
}

async function measureNaive() {
	return sampleSeries(async () => {
		const result = runNaive({
			id: ARTIFACT_ID,
			input: "v1",
			artifact: "v1",
			toolCoverage: "full",
			repeatConsumes: plan.repeatConsumptions,
		});
		try {
			return {
				consumable: result.consumable,
				repeatedChecks: result.repeatedChecks,
				executions: result.executions,
			};
		} finally {
			await removeNaiveDirectory(result.cwd);
		}
	});
}

async function measureCapture(fixture: CostFixture) {
	return sampleSeries(async () => {
		const observed = await captureReturnedInput(fixture.projectDir, "api.txt", {
			returned: "v1",
			content: "v1",
			selector: { kind: "file" },
		});
		return {
			version: observed.version,
			calls: 1,
			bytes: fixture.fileBytes.input,
		};
	});
}

async function measureQuery(fixture: CostFixture) {
	return sampleSeries(async () => ({
		calls: 1,
		rows: (await listArtifactReviews(fixture.bb)).length,
		bytesReadByJsonlScan:
			fixture.fileBytes.footprint + fixture.fileBytes.events,
	}));
}

async function measureManifest(fixture: CostFixture) {
	const exported = await sampleSeries(async () => {
		const manifest = await exportArtifactManifest(fixture.bb, CHECKPOINT_ID);
		const text = stableManifestJson(manifest);
		return {
			calls: 1,
			bytes: Buffer.byteLength(text),
			digest: manifest.digest,
		};
	});
	const manifest = await exportArtifactManifest(fixture.bb, CHECKPOINT_ID);
	const text = stableManifestJson(manifest);
	const consumed = await sampleSeries(async () => {
		const decoded = decodeArtifactManifest(text);
		if (decoded.status !== "valid") throw new Error(decoded.reason);
		const assessment = assessArtifactManifest(decoded.manifest);
		return {
			calls: 1,
			bytes: Buffer.byteLength(text),
			status: assessment.status,
			issues: assessment.issues,
		};
	});
	return { exported, consumed, bytes: Buffer.byteLength(text) };
}

const native = await measureNaive();
const budgetExceeded: Array<{ scope: string; values: number[] }> = [];
const scales: unknown[] = [];
for (const rows of plan.ledgerRows) {
	const fixture = await makeCostFixture(rows, true);
	let fixtureCosts: {
		capture: Awaited<ReturnType<typeof measureCapture>>;
		query: Awaited<ReturnType<typeof measureQuery>>;
		manifest: Awaited<ReturnType<typeof measureManifest>>;
		fileBytes: CostFixture["fileBytes"];
	};
	try {
		const capture = await measureCapture(fixture);
		const query = await measureQuery(fixture);
		const manifest = await measureManifest(fixture);
		fixtureCosts = { capture, query, manifest, fileBytes: fixture.fileBytes };
		for (const [scope, series] of Object.entries({
			capture,
			query,
			manifestExport: manifest.exported,
			manifestConsume: manifest.consumed,
		}))
			if (series.overBudgetMs.length)
				budgetExceeded.push({
					scope: `${rows}:${scope}`,
					values: series.overBudgetMs,
				});
	} finally {
		await fixture.cleanup();
	}
	const enhanced = await measureEnhanced(rows);
	if (enhanced.overBudgetMs.length)
		budgetExceeded.push({
			scope: `${rows}:enhanced`,
			values: enhanced.overBudgetMs,
		});
	const comparison = compareTiming(
		enhanced.hot.map((row) => row.wallMs),
		native.hot.map((row) => row.wallMs),
	);
	const safetyViolations = enhanced.hot.flatMap((row, index) => {
		const problems: string[] = [];
		if (!row.consumable) problems.push(`sample-${index + 1}:guard-rejected`);
		if (row.verificationRequests !== 1)
			problems.push(`sample-${index + 1}:checks=${row.verificationRequests}`);
		if (row.guardQueries !== plan.repeatConsumptions)
			problems.push(`sample-${index + 1}:guards=${row.guardQueries}`);
		if (row.copyBytes === null || row.copyMs === null)
			problems.push(`sample-${index + 1}:fixed-copy-unmeasured`);
		if (row.reviewStatus !== "current")
			problems.push(`sample-${index + 1}:review=${row.reviewStatus}`);
		return problems;
	});
	scales.push({
		rows,
		fileBytes: fixtureCosts.fileBytes,
		capture: fixtureCosts.capture,
		query: fixtureCosts.query,
		manifest: fixtureCosts.manifest,
		enhanced,
		naive: native,
		comparison,
		calls: {
			enhancedVerificationRequests: enhanced.hot.map(
				(row) => row.verificationRequests,
			),
			naiveChecks: native.hot.map((row) => row.repeatedChecks),
		},
		copy: {
			copyMs: enhanced.hot.every((row) => typeof row.copyMs === "number")
				? distribution(enhanced.hot.map((row) => row.copyMs as number))
				: null,
			copyBytes: enhanced.hot.map((row) => row.copyBytes),
		},
		safetyViolations,
	});
	console.log(
		JSON.stringify({
			rows,
			enhancedMedianMs: comparison.enhanced.median,
			naiveMedianMs: comparison.naive.median,
			verdict: comparison.status,
			checks: [
				enhanced.hot[0]?.verificationRequests,
				native.hot[0]?.repeatedChecks,
			],
		}),
	);
}
if (native.overBudgetMs.length)
	budgetExceeded.push({ scope: "native", values: native.overBudgetMs });
const safetyViolations = (
	scales as Array<{ safetyViolations: string[] }>
).flatMap((scale) => scale.safetyViolations);
const verdicts = (
	scales as Array<{ comparison: ReturnType<typeof compareTiming> }>
).map((scale) => scale.comparison.status);
const subject = execFileSync("git", ["rev-parse", "HEAD"], {
	cwd: repo,
	encoding: "utf8",
}).trim();
const output = {
	schemaVersion: 1,
	planDigest: freeze.planDigest,
	subject,
	environment: {
		platform: process.platform,
		arch: process.arch,
		bun: Bun.version,
		node: process.version,
		cpu: cpus()[0]?.model ?? null,
		logicalCpus: cpus().length,
		totalMemoryBytes: totalmem(),
		freeMemoryBytes: freemem(),
	},
	plan: {
		timing: plan.timing,
		ledgerRows: plan.ledgerRows,
		repeatConsumptions: plan.repeatConsumptions,
		budget: plan.budget,
	},
	native,
	scales,
	budgetExceeded,
	safetyViolations,
	summary: {
		verdicts,
		allScalesSeparatedLower: verdicts.every(
			(verdict) => verdict === "lower-separated-time-observed",
		),
		recommendation: safetyViolations.length
			? "stop-expansion-safety"
			: budgetExceeded.length
				? "stop-expansion-budget"
				: verdicts.some(
							(verdict) => verdict === "lower-separated-time-observed",
						)
					? "candidate-for-limited-claim"
					: "retain-simple-where-no-separated-time-gain",
		generalSpeedClaim: false,
		effectsApplied: false,
	},
	modelTokens: null,
	modelCost: null,
	limitations:
		"Controlled Windows local files and synthetic ledger scales; no provider, human productivity, general capacity or market result. Fixed-copy metrics are part of verification, not a capacity promise.",
};
const outputIndex = process.argv.indexOf("--output");
if (outputIndex >= 0)
	await writeFile(
		process.argv[outputIndex + 1]!,
		JSON.stringify(output, null, 2),
	);
console.log(
	JSON.stringify(
		{ ...output, scales: undefined, native: { ...native, hot: undefined } },
		null,
		2,
	),
);
if (safetyViolations.length || plan.schemaVersion !== 1) process.exitCode = 1;
