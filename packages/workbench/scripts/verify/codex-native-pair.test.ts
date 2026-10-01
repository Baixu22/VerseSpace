import { expect, test } from "bun:test";
import { nativeCasePassed } from "./codex-native-pair";

test("native acceptance requires attributable seal decisions and the fresh/stale causal controls", () => {
	for (const stale of [false, true]) {
		const value = {
			measured: true,
			writeMode: "native",
			writerId: "w",
			case: stale ? "own-stale" : "own-fresh",
			staleClaims: stale ? 1 : 0,
			readDuringWrite: 0,
			writeLanded: !stale,
			writeFootprints: stale ? 0 : 1,
			sealEventsAfterCodex: 1,
			controlDecision: stale ? "block" : "pass",
			sealDecisions: [
				{
					path: "src/target.ts",
					writer: "w",
					decision: stale ? "block" : "pass",
					hit: stale,
					downgraded: false,
				},
			],
		};
		expect(nativeCasePassed(value, stale)).toBe(true);
		for (const invalid of [
			{ measured: false },
			{ readDuringWrite: 1 },
			{ writeMode: "shell" },
			{ sealEventsAfterCodex: 0 },
			{ writeLanded: stale },
			{ sealDecisions: [{ ...value.sealDecisions[0], writer: "other" }] },
		])
			expect(nativeCasePassed({ ...value, ...invalid }, stale)).toBe(false);
	}
});
