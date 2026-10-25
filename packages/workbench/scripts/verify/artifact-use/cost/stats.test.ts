import { expect, test } from "bun:test";
import { compareTiming, distribution, overBudget } from "./stats";

test("distribution reports nearest-rank median and p95", () => {
	const result = distribution([9, 1, 5, 3, 7]);
	expect(result).toMatchObject({
		samples: 5,
		min: 1,
		median: 5,
		p95: 9,
		max: 9,
	});
});

test("comparison requires a lower median and separated sample ranges", () => {
	expect(compareTiming([1, 2, 3], [4, 5, 6]).status).toBe(
		"lower-separated-time-observed",
	);
	expect(compareTiming([1, 5, 6], [2, 3, 4]).status).toBe(
		"no-net-time-benefit",
	);
	expect(compareTiming([5, 6, 7], [1, 2, 3]).status).toBe(
		"no-net-time-benefit",
	);
});

test("over-budget samples are retained instead of clipped or normalized", () => {
	expect(overBudget([1, 60_001, 2], 60_000)).toEqual([60_001]);
});
