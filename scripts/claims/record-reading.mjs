#!/usr/bin/env node
/**
 * Deposit a reading for a registered claim (TF-0274).
 *
 * Recording by hand is how a reading's instrument hash drifts from the gate's —
 * so this tool computes the hash, the subject commit and the raw digest itself,
 * using the same `instrumentKey` the gate uses.
 *
 * Usage:
 *   node scripts/claims/record-reading.mjs <claim-id> \
 *     --reading '{"pass":1004,"fail":0}' \
 *     [--raw <file-with-the-raw-output>] \
 *     [--environment '{"os":"windows","bun":"1.3.14"}'] \
 *     [--reproduce "bun run test:workbench"]
 *
 * The raw output belongs in evidence/raw/ (gitignored): ADR-0020 keeps raw
 * process evidence local, and only its digest travels.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { instrumentKey } from "./ledger.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function argValue(flag) {
	const i = process.argv.indexOf(flag);
	return i === -1 ? undefined : process.argv[i + 1];
}

const claimId = process.argv[2];
if (!claimId || claimId.startsWith("--")) {
	console.error(
		"用法：node scripts/claims/record-reading.mjs <claim-id> --reading '<json>'",
	);
	process.exit(2);
}

const claims = JSON.parse(
	readFileSync(join(REPO, "evidence", "claims.json"), "utf8"),
).claims;
const claim = claims.find((entry) => entry.id === claimId);
if (!claim) {
	console.error(`未登记的声明：${claimId}（先在 evidence/claims.json 里登记）`);
	process.exit(2);
}

const readingRaw = argValue("--reading");
if (!readingRaw) {
	console.error("缺 --reading '<json>'");
	process.exit(2);
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const hashes = {};
for (const path of claim.instrument ?? []) {
	hashes[path] = sha256(readFileSync(join(REPO, path), "utf8"));
}

const subjectSha =
	argValue("--subject-sha") ??
	execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: REPO,
		encoding: "utf8",
	}).trim();

const rawPath = argValue("--raw");
const reading = {
	claim_id: claimId,
	instrument_sha256: instrumentKey(claim, hashes),
	subject_sha: subjectSha,
	environment: argValue("--environment")
		? JSON.parse(argValue("--environment"))
		: {},
	measured_at: new Date().toISOString(),
	reading: JSON.parse(readingRaw),
	raw_digest:
		rawPath && existsSync(rawPath)
			? `sha256:${sha256(readFileSync(rawPath, "utf8"))}`
			: null,
	reproduce: argValue("--reproduce") ?? claim.reproduce ?? null,
	class: claim.class === "L1" ? "curated-evidence" : "process-evidence",
};

mkdirSync(join(REPO, "evidence", "readings"), { recursive: true });
const out = join(REPO, "evidence", "readings", `${claimId}.json`);
writeFileSync(out, `${JSON.stringify(reading, null, 2)}\n`);
console.log(`已记录读数：${out}`);
console.log(
	`  instrument ${reading.instrument_sha256.slice(0, 24)}… · subject ${subjectSha.slice(0, 12)}`,
);
