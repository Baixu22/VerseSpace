/** Frozen oracle. No production imports; expectations come only from cases.json. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const fixturePath = new URL(
	"../../../fixtures/artifact-use/cases.json",
	import.meta.url,
);
export const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
export const digest = (bytes) =>
	createHash("sha256").update(bytes).digest("hex");
export const fixtureDigest = digest(readFileSync(fixturePath));

export function judge(rows, cases = fixture.cases) {
	assert.equal(
		new Set(rows.map((r) => r.id)).size,
		rows.length,
		"duplicate observations",
	);
	assert.equal(rows.length, cases.length, "incomplete observations");
	const result = {
		cases: cases.length,
		errors: 0,
		falseCurrent: 0,
		falseReject: 0,
		sourceMisattribution: 0,
		costBudgetExceeded: 0,
		unknown: 0,
		details: [],
	};
	for (const spec of cases) {
		const observed = rows.find((row) => row.id === spec.id);
		assert.ok(observed, `missing ${spec.id}`);
		for (const [key, expected] of Object.entries(spec.expected)) {
			const value =
				key.endsWith("Input") && expected !== null
					? digest(expected)
					: expected;
			if (observed[key] === value) continue;
			if (key === "repeatedChecks" && typeof observed[key] === "number") {
				result.costBudgetExceeded++;
				result.details.push({
					id: spec.id,
					key,
					expected: value,
					actual: observed[key],
					status: "cost-budget-exceeded",
				});
				continue;
			}
			if (observed[key] === null || observed[key] === undefined) {
				result.unknown++;
				result.details.push({ id: spec.id, key, status: "unknown" });
				continue;
			}
			result.errors++;
			if (key === "consumable") {
				if (observed[key]) result.falseCurrent++;
				else result.falseReject++;
			} else if (key.endsWith("Input")) result.sourceMisattribution++;
			result.details.push({
				id: spec.id,
				key,
				expected: value,
				actual: observed[key],
				status: "error",
			});
		}
	}
	return result;
}
