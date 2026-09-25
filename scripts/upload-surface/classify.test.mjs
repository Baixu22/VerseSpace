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
