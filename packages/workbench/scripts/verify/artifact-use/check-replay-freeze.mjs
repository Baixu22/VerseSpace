import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { digest } from "./judge.mjs";

const repo = fileURLToPath(new URL("../../../../../", import.meta.url));
const planBytes = readFileSync(
	new URL("../../../fixtures/artifact-use/replay-plan.json", import.meta.url),
);
const plan = JSON.parse(planBytes);
const freeze = JSON.parse(
	readFileSync(
		new URL(
			"../../../fixtures/artifact-use/replay-plan-freeze.json",
			import.meta.url,
		),
	),
);
if (digest(planBytes) !== freeze.planDigest)
	throw new Error("replay plan drift");
for (const [path, hash] of Object.entries(freeze.observerSha256)) {
	if (digest(readFileSync(new URL(path, import.meta.url))) !== hash)
		throw new Error(`observer drift ${path}`);
}
const tree = (ref) =>
	execFileSync("git", ["rev-parse", `${ref}:packages/workbench/src`], {
		cwd: repo,
		encoding: "utf8",
	}).trim();
if (
	tree(plan.planningBaseline) !== plan.baselineSourceTree ||
	tree(plan.frozenBaseline) !== plan.baselineSourceTree
)
	throw new Error("planning baseline source differs from frozen baseline");
console.log(
	JSON.stringify({
		exit: 0,
		planDigest: freeze.planDigest,
		observerFiles: Object.keys(freeze.observerSha256).length,
		baselineSourceTree: plan.baselineSourceTree,
	}),
);
