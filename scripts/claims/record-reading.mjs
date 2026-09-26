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
import { execFileSync, spawnSync } from "node:child_process";
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

// `--run` makes the recorder execute the instrument itself. Without it the exit
// code is whatever the caller typed — measured 2026-09-26: a hand-typed
// `exit: 0` was recorded for `claim-lint` while `bun run lint` had exited 1. The
// gate now flags that contradiction (`instrument_exit` vs `reading.exit`), and the
// recorder refuses to write it in the first place.
const rawPath =
	argValue("--raw") ?? join(REPO, "evidence", "raw", `${claimId}.txt`);
const command = argValue("--reproduce") ?? claim.reproduce ?? null;
let instrumentExit = null;
if (process.argv.includes("--run")) {
	if (!command) {
		console.error(`声明 ${claimId} 没有 reproduce 命令，无法 --run`);
		process.exit(2);
	}
	mkdirSync(dirname(rawPath), { recursive: true });
	const result = spawnSync(command, {
		cwd: REPO,
		shell: true,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	writeFileSync(rawPath, `${result.stdout ?? ""}${result.stderr ?? ""}`);
	instrumentExit = result.status;
	console.log(`  已跑仪器：${command} → exit ${instrumentExit}`);
}

const readingValue = JSON.parse(readingRaw);
if (
	instrumentExit !== null &&
	typeof readingValue.exit === "number" &&
	readingValue.exit !== instrumentExit
) {
	console.error(
		`拒绝记录：--reading 说 exit=${readingValue.exit}，仪器实际 exit=${instrumentExit}`,
	);
	process.exit(2);
}

// An instrument that did not finish cleanly cannot produce evidence. Measured
// 2026-09-26: the codex write-side instrument exited 2 ("cannot measure") and the
// recorder happily wrote a reading that claimed success — the same class of hole
// as the hand-typed exit code above. A claim may opt in via `expects_nonzero_exit`
// when a non-zero exit IS the asserted outcome.
if (
	instrumentExit !== null &&
	instrumentExit !== 0 &&
	claim.expects_nonzero_exit !== true
) {
	console.error(
		`拒绝记录：仪器 exit=${instrumentExit}（没有测出来），不能当作证据。声明若确实断言非零退出，设 expects_nonzero_exit: true。`,
	);
	process.exit(2);
}

const reading = {
	claim_id: claimId,
	instrument_sha256: instrumentKey(claim, hashes),
	subject_sha: subjectSha,
	environment: argValue("--environment")
		? JSON.parse(argValue("--environment"))
		: {},
	measured_at: new Date().toISOString(),
	reading: readingValue,
	instrument_exit: instrumentExit,
	raw_digest: existsSync(rawPath)
		? `sha256:${sha256(readFileSync(rawPath, "utf8"))}`
		: null,
	reproduce: command,
	class: claim.class === "L1" ? "curated-evidence" : "process-evidence",
};

mkdirSync(join(REPO, "evidence", "readings"), { recursive: true });
const out = join(REPO, "evidence", "readings", `${claimId}.json`);
writeFileSync(out, `${JSON.stringify(reading, null, 2)}\n`);
console.log(`已记录读数：${out}`);
console.log(
	`  instrument ${reading.instrument_sha256.slice(0, 24)}… · subject ${subjectSha.slice(0, 12)}`,
);
