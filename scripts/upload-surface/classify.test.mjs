/**
 * Tests for the upload-surface classifier (ADR-0020).
 *
 * These are the assertions the gate's verdict rests on, so they are written
 * against the two failure directions by name:
 *
 *   useful-not-uploaded — 有用未传 (the 2026-09-25 handoff report)
 *   useless-uploaded    — 无用已传 (a log or build artifact reaching history)
 *
 * plus `unclassified`, which is what makes "silence is not a decision"
 * mechanical rather than aspirational.
 *
 * Run: node --test scripts/upload-surface/classify.test.mjs
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	classifyPath,
	compilePolicy,
	evaluate,
	globToRegExp,
	isAcceptedLocalReference,
} from "./classify.mjs";
import { loadPolicy } from "./policy-loader.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const policy = {
	version: 1,
	defaultClass: "unclassified",
	sizeLimitBytes: 1000,
	sizeExceptions: ["docs/handoff/big-but-allowed.json"],
	classes: {
		outcome: { upload: true },
		"curated-evidence": { upload: true },
		"process-evidence": { upload: false },
		"machine-state": { upload: false },
		unclassified: { upload: false },
	},
	rules: [
		{
			globs: ["docs/handoff/**"],
			class: "outcome",
			why: "handoff records ship",
		},
		{
			globs: ["docs/**"],
			class: "process-evidence",
			why: "dated reports stay local",
		},
		{ globs: ["**/node_modules/**"], class: "machine-state", why: "deps" },
		{ globs: ["**/*.log"], class: "process-evidence", why: "logs" },
	],
};

test("glob: `**/` spans zero or more segments", () => {
	assert.ok(globToRegExp("**/node_modules/**").test("node_modules/a/b.js"));
	assert.ok(
		globToRegExp("**/node_modules/**").test("packages/x/node_modules/a.js"),
	);
	assert.ok(
		!globToRegExp("**/node_modules/**").test("packages/x/node_modules"),
	);
});

test("glob: a trailing slash means the whole subtree, not just the directory", () => {
	// This is the regression that mattered: `docs/handoff/**` once compiled to
	// `^docs/handoff$`, so the gate would have reported the handoff report as
	// unclassified forever without ever explaining why.
	assert.ok(globToRegExp("docs/handoff/**").test("docs/handoff/a.md"));
	assert.ok(globToRegExp("docs/handoff/**").test("docs/handoff/2026/a.md"));
	assert.ok(globToRegExp("docs/handoff/").test("docs/handoff/a.md"));
	assert.ok(!globToRegExp("docs/handoff/**").test("docs/handoff"));
});

test("glob: `*` stays inside one segment", () => {
	assert.ok(globToRegExp("*.md").test("README.md"));
	assert.ok(!globToRegExp("*.md").test("docs/README.md"));
	assert.ok(globToRegExp("**/*.log").test("fswatch.log"));
});

test("classify: first match wins, so a specific rule beats a broad one", () => {
	const compiled = compilePolicy(policy);
	assert.equal(classifyPath(compiled, "docs/handoff/x.md").class, "outcome");
	assert.equal(
		classifyPath(compiled, "docs/report-2026-01-01.md").class,
		"process-evidence",
	);
});

test("classify: an uncovered path is `unclassified`, never a silent pass", () => {
	const compiled = compilePolicy(policy);
	const verdict = classifyPath(compiled, "docs/whatever.md");
	assert.equal(verdict.class, "process-evidence");
	assert.equal(
		classifyPath(compiled, "mystery/thing.bin").class,
		"unclassified",
	);
});

test("evaluate: 有用未传 — an uploadable path that .gitignore excludes", () => {
	const result = evaluate({
		policy,
		uploaded: [],
		ignored: ["docs/handoff/2026-09-25.md"],
	});
	assert.equal(result.status, "violations");
	assert.equal(result.violations.length, 1);
	assert.equal(result.violations[0].code, "useful-not-uploaded");
	assert.equal(result.violations[0].path, "docs/handoff/2026-09-25.md");
});

test("evaluate: 无用已传 — a local-only path that reached the upload surface", () => {
	const result = evaluate({
		policy,
		uploaded: ["node_modules/left-pad/index.js", "docs/handoff/ok.md"],
		ignored: [],
	});
	assert.equal(result.status, "violations");
	const codes = result.violations.map((item) => item.code);
	assert.deepEqual(codes, ["useless-uploaded"]);
	assert.equal(result.violations[0].path, "node_modules/left-pad/index.js");
});

test("evaluate: unclassified is a violation on both sides", () => {
	const result = evaluate({
		policy,
		uploaded: ["mystery/a.bin"],
		ignored: ["mystery/b.bin"],
	});
	const codes = result.violations.map((item) => item.code).sort();
	assert.deepEqual(codes, ["unclassified", "unclassified"]);
});

test("evaluate: oversize is caught, and sizeExceptions suppresses it", () => {
	const over = evaluate({
		policy,
		uploaded: ["docs/handoff/huge.bin"],
		ignored: [],
		sizes: { "docs/handoff/huge.bin": 5000 },
	});
	assert.deepEqual(
		over.violations.map((item) => item.code),
		["oversize-uploaded"],
	);

	const allowed = evaluate({
		policy,
		uploaded: ["docs/handoff/big-but-allowed.json"],
		ignored: [],
		sizes: { "docs/handoff/big-but-allowed.json": 5000 },
	});
	assert.equal(allowed.status, "clean");
});

test("evaluate: a clean surface reports clean with class tallies", () => {
	const result = evaluate({
		policy,
		uploaded: ["docs/handoff/ok.md"],
		ignored: ["docs/old-report.md", "node_modules/x/y.js"],
	});
	assert.equal(result.status, "clean");
	assert.deepEqual(result.counts.byClass, {
		outcome: 1,
		"process-evidence": 1,
		"machine-state": 1,
	});
});

test("real policy: docs/handoff is uploadable, docs/ root is not", () => {
	const real = loadPolicy({
		policyPath: join(HERE, "policy.json"),
		inventoryPath: join(HERE, "legacy-local-docs.json"),
	});
	const compiled = compilePolicy(real);

	const handoff = classifyPath(compiled, "docs/handoff/2026-09-25-round.md");
	assert.equal(handoff.class, "outcome");
	assert.equal(real.classes[handoff.class].upload, true);

	// A NEW doc at docs/ root is unclassified unless it is in the frozen
	// inventory — that is what turns "I forgot to whitelist it" into a red gate.
	assert.equal(
		classifyPath(compiled, "docs/brand-new-report-2026-10-01.md").class,
		"unclassified",
	);
	// ...while an inventoried legacy doc is explicitly accepted as local-only.
	assert.equal(
		classifyPath(compiled, "docs/report-2026-09-07-mainline.md").class,
		"process-evidence",
	);
});

test("real policy: E2E artifacts under a nested package are local-only", () => {
	// 2026-09-25: the first real Chromium run wrote apps/workbench-ui/test-results/,
	// and the gate reported 7 useful-not-uploaded violations. The rule existed but
	// its globs were root-anchored (`test-results/**`), so a nested package never
	// matched. E2E 现场 is process-evidence (ADR-0020) and is never uploaded.
	const real = loadPolicy({
		policyPath: join(HERE, "policy.json"),
		inventoryPath: join(HERE, "legacy-local-docs.json"),
	});
	const compiled = compilePolicy(real);

	for (const path of [
		"apps/workbench-ui/test-results/.last-run.json",
		"apps/workbench-ui/test-results/case/trace.zip",
		"apps/workbench-ui/test-results/case/test-failed-1.png",
		"apps/workbench-ui/test-results/case/error-context.md",
		"apps/workbench-ui/playwright-report/index.html",
		"test-results/at-the-root.json",
	]) {
		const verdict = classifyPath(compiled, path);
		assert.equal(verdict.class, "process-evidence", path);
		assert.equal(real.classes[verdict.class].upload, false, path);
	}
});

test("real policy: misplaced Windows caches stay local and cannot be uploaded", () => {
	const real = loadPolicy({
		policyPath: join(HERE, "policy.json"),
		inventoryPath: join(HERE, "legacy-local-docs.json"),
	});
	const caches = [
		"%SystemDrive%/ProgramData/Microsoft/Windows/Caches/cversions.2.db",
		"%SystemDrive%/ProgramData/Microsoft/Windows/Caches/{6AF0698E-D558-4F6E-9B3C-3716689AF493}.2.ver0x0000000000000001.db",
		"%SystemDrive%/ProgramData/Microsoft/Windows/Caches/{DDF571F2-BE98-426D-8288-1A9A39C3FDA2}.2.ver0x0000000000000001.db",
	];
	assert.equal(evaluate({ policy: real, ignored: caches }).status, "clean");
	assert.deepEqual(
		evaluate({ policy: real, uploaded: caches }).violations.map((v) => v.code),
		caches.map(() => "useless-uploaded"),
	);
	const compiled = compilePolicy(real);
	for (const path of [
		"%SystemDrive%/ProgramData/Microsoft/Windows/Other/cache.db",
		"%SystemDrive%/ProgramData/Microsoft/Windows/Caches-backup/cache.db",
		"data/application.db",
	]) {
		assert.equal(classifyPath(compiled, path).class, "unclassified", path);
	}
	assert.equal(classifyPath(compiled, "README.md").class, "outcome");
});

test("real policy: the frozen inventory may only shrink", () => {
	// Guards the doctrine rather than the code: an entry that an explicit rule
	// now covers is dead weight, and the list growing is how "有用未传" would
	// come back. The count is a ratchet — lower it when entries are promoted.
	const real = loadPolicy({
		policyPath: join(HERE, "policy.json"),
		inventoryPath: join(HERE, "legacy-local-docs.json"),
	});
	const inventoryRule = real.rules.at(-1);
	assert.ok(
		inventoryRule.globs.length <= 74,
		`清单增长到 ${inventoryRule.globs.length} 条`,
	);
});

test("accepted reference: only an exact (referrer, local) pair counts", () => {
	const accepted = [
		{
			referrer: "docs/handoff/2026-09-25-upload-surface-round.md",
			localPaths: ["docs/positioning-v5.md"],
		},
	];
	assert.ok(
		isAcceptedLocalReference(
			accepted,
			"docs/positioning-v5.md",
			"docs/handoff/2026-09-25-upload-surface-round.md",
		),
	);
	// A different referrer must NOT inherit the decision: that is exactly how a
	// brand-new dead pointer would slip through if this matched by glob.
	assert.ok(
		!isAcceptedLocalReference(
			accepted,
			"docs/positioning-v5.md",
			"docs/handoff/2026-10-01-next-round.md",
		),
	);
	assert.ok(
		!isAcceptedLocalReference(
			accepted,
			"docs/positioning-v6.md",
			"docs/handoff/2026-09-25-upload-surface-round.md",
		),
	);
	assert.ok(!isAcceptedLocalReference(undefined, "docs/a.md", "docs/b.md"));
});

test("real policy: adjudicated references are recorded, reasoned, and still local-only", () => {
	// 2026-09-26 closeout: ADR-0020 §复核 said "adjudicate the 6, then add
	// --strict-references". The adjudication is a decision, so it lives in the
	// policy rather than in a rewritten dated record. The set of accepted entries
	// grows as further pre-existing local-only references are adjudicated; the test
	// therefore checks structure, not a hard-coded count.
	const real = loadPolicy({
		policyPath: join(HERE, "policy.json"),
		inventoryPath: join(HERE, "legacy-local-docs.json"),
	});
	const accepted = real.acceptedLocalReferences ?? [];
	assert.ok(accepted.length >= 1, "at least the 2026-09-25 adjudication exists");
	// The original 2026-09-25 adjudication must remain intact (regression guard).
	const original = accepted.find(
		(e) => e.referrer === "docs/handoff/2026-09-25-upload-surface-round.md",
	);
	assert.ok(original, "2026-09-25 adjudication entry preserved");
	assert.equal(original.localPaths.length, 6);
	assert.ok(original.why.length > 20, "例外必须写明理由");
	// Every accepted entry must be reasoned, and every accepted local doc must
	// actually be local-only under the real policy - otherwise the entry is stale
	// and the gate is excusing a reference to a file that ships.
	const compiled = compilePolicy(real);
	for (const entry of accepted) {
		assert.ok(entry.why && entry.why.length > 20, "每个例外必须写明理由");
		for (const local of entry.localPaths ?? []) {
			assert.equal(
				real.classes[classifyPath(compiled, local).class].upload,
				false,
				local,
			);
		}
	}
});

