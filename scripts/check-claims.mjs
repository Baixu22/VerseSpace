#!/usr/bin/env node
/**
 * Claim-evidence gate (TF-0274).
 *
 * Every number we write down has to name the instrument that produced it and the
 * state it was produced in. This gate enforces that:
 *
 *   1. each registered claim has a deposited reading (missing → violation);
 *   2. the instrument's current content hashes to what the reading recorded
 *      (changed → stale);
 *   3. nothing under the claim's `subject_paths` has changed since the reading's
 *      commit (changed → stale);
 *   4. the reading carries the numbers the claim is about (shape).
 *
 * Exit codes: 0 clean · 1 drift · 2 cannot measure. **Exit 2 is never a pass** —
 * same rule as `check-forest-landing.mjs` and `check-upload-surface.mjs`.
 *
 * Usage: node scripts/check-claims.mjs [--json] [--root <dir>]
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { evaluateClaims } from "./claims/ledger.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function argValue(flag) {
	const i = process.argv.indexOf(flag);
	return i === -1 ? undefined : process.argv[i + 1];
}

const root = resolve(argValue("--root") ?? REPO);
const asJson = process.argv.includes("--json");
const claimsPath = join(root, "evidence", "claims.json");
const readingsDir = join(root, "evidence", "readings");

function sha256(text) {
	return createHash("sha256").update(text).digest("hex");
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

let measured = true;
const problems = [];
const notes = [];

let claims = [];
let readings = [];
try {
	claims = readJson(claimsPath).claims ?? [];
} catch (error) {
	measured = false;
	problems.push(`读不到 ${claimsPath}：${error.message}`);
}
if (measured) {
	try {
		readings = existsSync(readingsDir)
			? readdirSync(readingsDir)
					.filter((name) => name.endsWith(".json"))
					.map((name) => readJson(join(readingsDir, name)))
			: [];
	} catch (error) {
		measured = false;
		problems.push(`读不到 ${readingsDir}：${error.message}`);
	}
}

// Instrument hashes: sha256 of every instrument file, keyed by repo-relative path.
const instrumentHashes = {};
const instrumentPaths = new Set(
	claims.flatMap((claim) => claim.instrument ?? []),
);
for (const path of instrumentPaths) {
	const full = join(root, path);
	try {
		instrumentHashes[path] = sha256(readFileSync(full, "utf8"));
	} catch {
		// Left absent on purpose: evaluateClaim reports missing-instrument, which is
		// a violation rather than a measurement failure.
	}
}

// What changed between each reading's commit and HEAD. Per reading, because a
// path that moved *before* a reading was taken must not invalidate it.
const changedSince = [];
if (measured) {
	const shas = [...new Set(readings.map((r) => r.subject_sha).filter(Boolean))];
	for (const sha of shas) {
		try {
			const out = execFileSync("git", ["diff", "--name-only", `${sha}..HEAD`], {
				cwd: root,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			});
			changedSince.push(...out.split("\n").filter(Boolean));
		} catch (error) {
			measured = false;
			problems.push(`git diff ${sha}..HEAD 失败（无法测量）：${error.message}`);
		}
	}
}

const result = measured
	? evaluateClaims({
			claims,
			readings,
			instrumentHashes,
			changedSince: [...new Set(changedSince)],
		})
	: {
			rows: [],
			problems: [],
			valid: 0,
			observations: 0,
			status: "cannot-measure",
		};

const status = !measured
	? "cannot-measure"
	: result.status === "clean"
		? "clean"
		: "drift";

if (asJson) {
	process.stdout.write(
		`${JSON.stringify({ status, claims: claims.length, readings: readings.length, ...result, problems, notes }, null, 2)}\n`,
	);
} else {
	console.log(
		`[claims] ${claims.length} 条声明 · ${readings.length} 条读数 · ${
			status === "clean" ? "一致" : status === "drift" ? "有失效" : "无法测量"
		}`,
	);
	for (const row of result.rows) {
		const mark =
			row.status === "valid" ? "✔" : row.status === "observation" ? "◻" : "✘";
		console.log(
			`  ${mark} ${row.id}  ${row.status}${row.detail ? ` — ${row.detail}` : ""}`,
		);
	}
	for (const note of notes) console.log(`  备注：${note}`);
	for (const problem of problems) console.log(`  ${problem}`);
}

process.exit(status === "cannot-measure" ? 2 : status === "drift" ? 1 : 0);
