import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const planBytes = readFileSync(
	new URL("../../../../fixtures/artifact-use/cost-plan.json", import.meta.url),
);
const plan = JSON.parse(planBytes);
const freeze = JSON.parse(
	readFileSync(
		new URL(
			"../../../../fixtures/artifact-use/cost-freeze.json",
			import.meta.url,
		),
	),
);
if (digest(planBytes) !== freeze.planDigest) throw new Error("cost plan drift");
if (
	plan.timing?.warmups !== 1 ||
	plan.timing?.samples !== 5 ||
	plan.timing?.maxSampleMs !== 60_000 ||
	plan.repeatConsumptions !== 4 ||
	plan.ledgerRows?.join(",") !== "1000,10000,50000"
)
	throw new Error("cost plan definition drift");
for (const [path, hash] of Object.entries(freeze.observerSha256)) {
	if (digest(readFileSync(new URL(path, import.meta.url))) !== hash)
		throw new Error(`cost observer drift ${path}`);
}
console.log(
	JSON.stringify({
		exit: 0,
		planDigest: freeze.planDigest,
		observerFiles: Object.keys(freeze.observerSha256).length,
		warmups: plan.timing.warmups,
		samples: plan.timing.samples,
		ledgerRows: plan.ledgerRows,
		repeatConsumptions: plan.repeatConsumptions,
	}),
);
