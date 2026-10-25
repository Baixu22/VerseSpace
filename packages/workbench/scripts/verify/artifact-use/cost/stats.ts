export type Distribution = {
	samples: number;
	min: number;
	median: number;
	p95: number;
	max: number;
	values: number[];
};

export function distribution(values: number[]): Distribution {
	if (!values.length) throw new Error("distribution needs at least one sample");
	const sorted = [...values].sort((a, b) => a - b);
	const percentile = (fraction: number) =>
		sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
	return {
		samples: sorted.length,
		min: sorted[0]!,
		median: percentile(0.5),
		p95: percentile(0.95),
		max: sorted.at(-1)!,
		values: sorted,
	};
}

export function compareTiming(enhanced: number[], naive: number[]) {
	const enhancedDistribution = distribution(enhanced);
	const naiveDistribution = distribution(naive);
	const separated = Math.max(...enhanced) < Math.min(...naive);
	const lowerMedian = enhancedDistribution.median < naiveDistribution.median;
	return {
		enhanced: enhancedDistribution,
		naive: naiveDistribution,
		separated,
		lowerMedian,
		status:
			separated && lowerMedian
				? ("lower-separated-time-observed" as const)
				: ("no-net-time-benefit" as const),
	};
}

export function overBudget(values: number[], maxSampleMs: number) {
	return values.filter((value) => value > maxSampleMs);
}
