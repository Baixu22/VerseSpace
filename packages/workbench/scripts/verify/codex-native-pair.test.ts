import { expect, test } from "bun:test";
import {
	nativeCasePassed,
	unsealedNativeCaseObserved,
} from "./codex-native-pair";

test("native acceptance requires attributable seal decisions and the fresh/stale causal controls", () => {
	for (const stale of [false, true]) {
		const value = {
			measured: true,
			writeMode: "native",
			writerId: "w",
			case: stale ? "own-stale" : "own-fresh",
			staleClaims: stale ? 1 : 0,
			readDuringWrite: 0,
			finalThreadState: "idle",
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
			{ finalThreadState: "running" },
			{ writeMode: "shell" },
			{ sealEventsAfterCodex: 0 },
			{ writeLanded: stale },
			{ sealDecisions: [{ ...value.sealDecisions[0], writer: "other" }] },
		])
			expect(nativeCasePassed({ ...value, ...invalid }, stale)).toBe(false);
	}
});

test("unsealed evidence rejects missing measurements, stale controls and unobserved writes", () => {
	for (const stale of [false, true]) {
		const value = {
			measured: true,
			writerId: "w",
			writeMode: "native",
			case: stale ? "own-stale" : "own-fresh",
			staleClaims: stale ? 1 : 0,
			readDuringWrite: 0,
			finalThreadState: "idle",
			writeLanded: true,
			writeFootprints: 1,
			sealEventsAfterCodex: 0,
			sealDecisions: [],
			controlDecision: stale ? "block" : "pass",
		};
		expect(unsealedNativeCaseObserved(value, stale)).toBe(true);
		for (const invalid of [
			{ measured: false },
			{ writeFootprints: 0 },
			{ controlDecision: "unknown" },
			{ readDuringWrite: 1 },
			{ sealEventsAfterCodex: 1 },
		])
			expect(unsealedNativeCaseObserved({ ...value, ...invalid }, stale)).toBe(
				false,
			);
	}
});

test("readonly acceptance requires a live readonly seal, not a failed write or stale-premise decision", () => {
	const value = {
		measured: true,
		writeMode: "native",
		case: "own-fresh",
		writerId: "w",
		staleClaims: 0,
		readonlyArea: true,
		readDuringWrite: 0,
		finalThreadState: "idle",
		writeLanded: false,
		writeFootprints: 0,
		sealEventsAfterCodex: 1,
		controlDecision: "block",
		sealDecisions: [
			{
				path: "src/target.ts",
				writer: "w",
				decision: "block",
				kind: "readonly_area",
				hit: true,
				downgraded: false,
			},
		],
	};
	expect(nativeCasePassed(value, false, true)).toBe(true);
	expect(
		nativeCasePassed({ ...value, sealEventsAfterCodex: 0 }, false, true),
	).toBe(false);
	expect(
		nativeCasePassed(
			{
				...value,
				sealDecisions: [{ ...value.sealDecisions[0], kind: "stale_premise" }],
			},
			false,
			true,
		),
	).toBe(false);
});
