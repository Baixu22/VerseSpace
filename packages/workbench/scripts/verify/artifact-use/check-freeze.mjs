import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { digest } from "./judge.mjs";

const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const freeze = JSON.parse(
	readFileSync(
		new URL("../../../fixtures/artifact-use/freeze.json", import.meta.url),
		"utf8",
	),
);
for (const [path, hash] of Object.entries(freeze.sha256)) {
	assert.equal(
		digest(readFileSync(`${root}/${path}`)),
		hash,
		`frozen oracle changed: ${path}`,
	);
}
console.log(
	JSON.stringify({
		exit: 0,
		frozenFiles: Object.keys(freeze.sha256).length,
		baseline: freeze.baseline,
	}),
);
