/**
 * TF-0308: validate the finite moat claim family while preserving the full
 * claims gate as an independently reported global reading.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const expected = [
	"claim-moat-baseline",
	"claim-moat-source-baseline",
	"claim-moat-oracle",
	"claim-moat-controlled-comparison",
	"claim-moat-input-origin",
	"claim-moat-artifact-origin",
	"claim-moat-consumption",
	"claim-moat-verification-copy",
	"claim-moat-portable-evidence",
];
const check = spawnSync(
	process.execPath,
	["scripts/check-claims.mjs", "--json"],
	{
		cwd: repo,
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
		windowsHide: true,
	},
);
if (check.error || check.status === null || check.status === 2) {
	console.error(
		check.error?.message ?? check.stderr ?? "claims gate could not measure",
	);
	process.exit(2);
}
let ledger;
try {
	ledger = JSON.parse(check.stdout);
} catch (error) {
	console.error(`claims gate did not return JSON: ${String(error)}`);
	process.exit(2);
}
const moatRows = ledger.rows.filter((row) => row.id.startsWith("claim-moat-"));
const ids = moatRows.map((row) => row.id).sort();
const expectedIds = [...expected].sort();
if (ids.join("\n") !== expectedIds.join("\n")) {
	console.error(
		`moat claim family drift: expected ${expectedIds.join(", ")}; got ${ids.join(", ")}`,
	);
	process.exit(1);
}
const claims = moatRows.map((row) => {
	const reading = JSON.parse(
		readFileSync(join(repo, "evidence", "readings", `${row.id}.json`), "utf8"),
	);
	return {
		id: row.id,
		status: row.status,
		subjectSha: reading.subject_sha,
		instrumentExit: reading.instrument_exit,
		rawDigest: reading.raw_digest,
		reading: reading.reading,
	};
});
const invalid = claims.filter(
	(row) =>
		row.status !== "valid" ||
		row.instrumentExit !== 0 ||
		typeof row.rawDigest !== "string" ||
		!row.rawDigest.startsWith("sha256:"),
);
const output = {
	schemaVersion: 1,
	scope: "claim-moat-* only; the global claims gate remains a separate reading",
	global: {
		exit: check.status,
		status: ledger.status,
		problems: ledger.problems?.length ?? null,
	},
	summary: {
		claims: claims.length,
		valid: claims.filter((row) => row.status === "valid").length,
		invalid: invalid.length,
	},
	claims,
	invalid,
};
const outputIndex = process.argv.indexOf("--output");
if (outputIndex >= 0)
	writeFileSync(process.argv[outputIndex + 1], JSON.stringify(output, null, 2));
console.log(JSON.stringify({ ...output, claims: undefined }, null, 2));
if (invalid.length) process.exitCode = 1;
