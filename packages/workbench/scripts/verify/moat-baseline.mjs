/** TF-0285: verify the frozen source inventory, independently of today's HEAD. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const subject = "a7197bacd7159e704278a0dd5cf2233952d4e0fe";
const tag = "workbench-v0.4.1";
const git = (...args) =>
	execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const inventory = {
	"packages/workbench/src/blackboard/footprint.ts": "hashPathClaim",
	"packages/workbench/src/blackboard/session-types.ts": "FootprintUsed",
	"packages/workbench/src/types/artifact-evidence.ts":
		"artifactDeclarationSchema",
	"packages/workbench/src/artifacts/status.ts": "listArtifactReviews",
	"packages/workbench/src/artifacts/revalidate.ts": "revalidateArtifact",
	"packages/workbench/src/artifacts/snapshot.ts": "captureArtifactSnapshot",
	"packages/workbench/src/verifier/evidence-report.ts":
		"collectVerificationEvidence",
};
const doc = readFileSync(
	resolve(root, "docs/handoff/2026-10-25-moat-baseline.md"),
	"utf8",
);
assert.ok(
	doc.includes(subject),
	"handoff must identify the frozen source commit",
);
const releaseCommit = git("rev-parse", `${tag}^{commit}`);
assert.ok(
	doc.includes(releaseCommit),
	"release and source identities must differ",
);
const files = Object.entries(inventory).map(([path, symbol]) => {
	const text = git("show", `${subject}:${path}`);
	assert.ok(
		text.includes(symbol),
		`${path}: missing frozen capability ${symbol}`,
	);
	assert.ok(
		doc.includes(path) && doc.includes(symbol),
		`${path}: missing reuse row`,
	);
	return { path, symbol, blob: git("rev-parse", `${subject}:${path}`) };
});
console.log(
	JSON.stringify({
		exit: 0,
		files: files.length,
		subject,
		release: { tag, commit: releaseCommit, execution: "not-run-this-round" },
		inventory: files,
		inventoryDigest: createHash("sha256")
			.update(JSON.stringify(files))
			.digest("hex"),
	}),
);
