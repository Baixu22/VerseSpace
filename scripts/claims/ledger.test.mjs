/**
 * Claim-ledger tests. Run directly — no test runner child process:
 *
 *   node scripts/claims/ledger.test.mjs
 *
 * (Same reason as `scripts/upload-surface/classify.test.mjs`: the gate must be
 * verifiable on hosts that deny spawning processes.)
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
	CLAIM_STATUS,
	evaluateClaim,
	evaluateClaims,
	matchesGlob,
} from "./ledger.mjs";

const claim = {
	id: "c1",
	instrument: ["scripts/a.mjs"],
	subject_paths: ["packages/workbench/src/**"],
	reading_shape: { sites: "number" },
	class: "L1",
};
const reading = {
	claim_id: "c1",
	instrument_sha256: "scripts/a.mjs:aaa",
	subject_sha: "deadbeef",
	reading: { sites: 140 },
	instrument_exit: 0,
};
const hashes = { "scripts/a.mjs": "aaa" };

test("valid: instrument unchanged and nothing the claim covers has moved", () => {
	assert.equal(
		evaluateClaim(claim, reading, hashes, ["docs/whatever.md"]).status,
		CLAIM_STATUS.valid,
	);
});

test("a docs-only commit does NOT invalidate a reading about src/", () => {
	// This is the whole reason subject_paths exists: otherwise every commit
	// would invalidate every reading and the gate would be noise.
	const rows = evaluateClaims({
		claims: [claim],
		readings: [reading],
		instrumentHashes: hashes,
		changedSinceBySha: {
			deadbeef: ["docs/handoff/x.md", "README.md", "AGENTS.md"],
		},
	});
	assert.equal(rows.status, "clean");
});

test("per-reading scoping: an older reading's changes do not invalidate a newer one", () => {
	// The first version merged every reading's changed-paths into one list and
	// applied it to every claim — so a reading taken today was marked stale by a
	// change that happened before it was taken.
	const rows = evaluateClaims({
		claims: [claim],
		readings: [{ ...reading, subject_sha: "newersha" }],
		instrumentHashes: hashes,
		changedSinceBySha: {
			oldersha: ["packages/workbench/src/index.ts"],
			newersha: [],
		},
	});
	assert.equal(rows.rows[0].status, CLAIM_STATUS.valid);
});

test("stale-subject: a change inside the covered paths invalidates it", () => {
	const row = evaluateClaim(claim, reading, hashes, [
		"packages/workbench/src/ui/server.ts",
	]);
	assert.equal(row.status, CLAIM_STATUS.staleSubject);
	assert.match(row.detail, /server\.ts/);
});

test("stale-instrument: touching the instrument invalidates it", () => {
	const row = evaluateClaim(claim, reading, { "scripts/a.mjs": "bbb" }, []);
	assert.equal(row.status, CLAIM_STATUS.staleInstrument);
});

test("missing-reading: a claim with no deposited reading is a problem", () => {
	const rows = evaluateClaims({
		claims: [claim],
		readings: [],
		instrumentHashes: hashes,
		changedSinceBySha: {},
	});
	assert.equal(rows.rows[0].status, CLAIM_STATUS.missingReading);
	assert.equal(rows.status, "drift");
});

test("missing-instrument: the instrument is not in the repo", () => {
	const row = evaluateClaim(claim, reading, {}, []);
	assert.equal(row.status, CLAIM_STATUS.missingInstrument);
});

test("bad-shape: a reading that lacks the numbers the claim is about", () => {
	const row = evaluateClaim(
		claim,
		{ ...reading, reading: { files: 61 } },
		hashes,
		[],
	);
	assert.equal(row.status, CLAIM_STATUS.badShape);
	assert.match(row.detail, /sites/);
});

test("contradicted: a reading claims an exit code the instrument did not produce", () => {
	// Measured 2026-09-26: `claim-lint` was recorded as exit 0 while `bun run lint`
	// had actually exited 1. Freshness does not fix a false reading.
	const row = evaluateClaim(
		claim,
		{ ...reading, reading: { sites: 140, exit: 0 }, instrument_exit: 1 },
		hashes,
		[],
	);
	assert.equal(row.status, CLAIM_STATUS.contradicted);
	assert.match(row.detail, /exit=1/);
});

test("L3 (retired instrument) is an observation, never evidence", () => {
	const l3 = { ...claim, class: "L3", retired_reason: "实验定义已被取代" };
	const rows = evaluateClaims({
		claims: [l3],
		readings: [reading],
		instrumentHashes: {},
		changedSinceBySha: {},
	});
	assert.equal(rows.rows[0].status, CLAIM_STATUS.observation);
	// clean verdict, but it is not counted as valid evidence either
	assert.equal(rows.status, "clean");
	assert.equal(rows.valid, 0);
	assert.equal(rows.observations, 1);
});

test("glob: ** spans zero or more segments, * stays inside one", () => {
	assert.equal(
		matchesGlob("packages/workbench/src/**", "packages/workbench/src/a/b.ts"),
		true,
	);
	assert.equal(
		matchesGlob("packages/workbench/src/**", "packages/workbench/test/a.ts"),
		false,
	);
	// zero segments: `**/x` matches `x`, and `/**` matches the bare directory
	assert.equal(matchesGlob("**/*.mjs", "a/b/c.mjs"), true);
	assert.equal(matchesGlob("**/*.mjs", "c.mjs"), true);
	assert.equal(matchesGlob("evidence/**", "evidence"), true);
	assert.equal(matchesGlob("evidence/**", "evidence/readings/a.json"), true);
	assert.equal(matchesGlob("scripts/*.mjs", "scripts/a.mjs"), true);
	assert.equal(matchesGlob("scripts/*.mjs", "scripts/sub/a.mjs"), false);
});

test("glob: a bare ** covers the whole repo, not just the top level", () => {
	// Measured 2026-09-26: `claim-upload-surface-clean` declares
	// `subject_paths: ["**"]` and stayed `valid` while two docs changed, because
	// `**` compiled to `^[^/]*[^/]*$` — top-level files only. A claim that reads
	// repo-wide but covers one level is worse than no claim at all.
	assert.equal(matchesGlob("**", "README.md"), true);
	assert.equal(matchesGlob("**", "docs/handoff/x.md"), true);
	assert.equal(matchesGlob("**", "packages/workbench/src/a.ts"), true);
});

test("a failed suite, mistyped values and missing execution cannot certify success", () => {
	const suite = {
		...claim,
		reading_shape: { pass: "number", fail: "number" },
		expected: { fail: 0 },
		minimum: { pass: 1 },
	};
	for (const [values, exit] of [
		[{ pass: 0, fail: 1 }, 1],
		[{ pass: "12", fail: 0 }, 0],
		[{ pass: 0, fail: 0 }, 0],
		[{ pass: 12, fail: 0 }, null],
		[{ pass: Number.NaN, fail: 0 }, 0],
	]) {
		assert.notEqual(
			evaluateClaim(
				suite,
				{ ...reading, reading: values, instrument_exit: exit },
				hashes,
				[],
			).status,
			CLAIM_STATUS.valid,
		);
	}
	assert.equal(
		evaluateClaim(
			suite,
			{ ...reading, reading: { pass: 12, fail: 0 }, instrument_exit: 0 },
			hashes,
			[],
		).status,
		CLAIM_STATUS.valid,
	);
});

test("a reading without a subject revision is not current evidence", () => {
	assert.equal(
		evaluateClaim(claim, { ...reading, subject_sha: undefined }, hashes, [])
			.status,
		CLAIM_STATUS.badShape,
	);
});

test("registered workbench evidence includes the scanner it imports", async () => {
	const { readFile } = await import("node:fs/promises");
	const { claims } = JSON.parse(
		await readFile(
			new URL("../../evidence/claims.json", import.meta.url),
			"utf8",
		),
	);
	const suite = claims.find((c) => c.id === "claim-workbench-suite");
	assert.ok(
		suite.subject_paths.some((g) =>
			matchesGlob(g, "packages/context-rot/src/scan.ts"),
		),
	);
	assert.ok(suite.subject_paths.includes("bun.lock"));
});
