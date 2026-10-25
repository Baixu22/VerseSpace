import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { hashText } from "../hash";
import { claimObservation, claimStrength, claimVersion } from "./claim-version";
import {
	type FootprintUsed,
	type InputObservation,
	inputObservationSchema,
} from "./session-types";
import { foldReadSet } from "./session-view";

const scenarios = JSON.parse(
	readFileSync(
		new URL("../../fixtures/artifact-use/cases.json", import.meta.url),
		"utf8",
	),
);
const spec = scenarios.cases.find(
	(row: { id: string }) => row.id === "capture-race",
);
const v1 = hashText(spec.input);
const v2 = hashText(spec.beforeCapture);
const observed: InputObservation = {
	schemaVersion: 1,
	source: "tool-observed",
	returnedHash: hashText(`returned:${spec.input}`),
	contentHash: v1,
	selector: { kind: "file" },
	normalization: "utf8-lines-v1",
	sample: { version: v2, contentHash: v2, stable: true },
};

test("returned content hash cannot be substituted by a newer file sample", () => {
	const result = claimObservation({
		path: "api.txt",
		version: v2,
		observation: observed,
	});
	expect(result.source).toBe("tool-observed");
	expect(result.binding).toBe("different");
	expect(result.contentHash).toBe(v1);
	expect(result.returnedHash).not.toBe(result.contentHash);
	const same = {
		...observed,
		sample: { version: v1, contentHash: v1, stable: true },
	};
	expect(
		claimObservation({ path: "api.txt", version: v1, observation: same })
			.binding,
	).toBe("matched");
});
test("legacy content/size evidence keeps premise behavior but never acquires strong origin", () => {
	const legacy = { path: "api.txt", version: v1 };
	expect(claimStrength(legacy)).toBe("content-hash");
	expect(claimVersion(legacy)).toBe(v1);
	expect(claimObservation(legacy).source).toBe("unknown");
	expect(claimStrength({ size: 3 })).toBe("size-only");
	expect(claimObservation({ path: "large.txt", size: 3 }).source).toBe(
		"unknown",
	);
});
test("stable sampling and explicit declarations are separately classified", () => {
	expect(
		claimObservation({
			path: "api.txt",
			version: v1,
			observation: {
				schemaVersion: 1,
				source: "fs-sample",
				sample: { version: v1, stable: true },
			},
		}).source,
	).toBe("fs-sample");
	expect(
		claimObservation({
			path: "api.txt",
			version: v1,
			observation: {
				schemaVersion: 1,
				source: "fs-sample",
				sample: { version: v1, stable: false },
			},
		}).source,
	).toBe("unknown");
	expect(
		claimObservation({
			path: "api.txt",
			observation: { schemaVersion: 1, source: "declared", contentHash: v1 },
		}).source,
	).toBe("declared");
});
test("directories, truncated output, invalid ranges and missing fields cannot assert observation", () => {
	for (const partial of [
		{ ...observed, selector: { kind: "directory" } },
		{ ...observed, selector: { kind: "lines", start: 2, end: 1 } },
		{ ...observed, returnedHash: null },
		{ ...observed, normalization: "unknown" },
	]) {
		expect(inputObservationSchema.safeParse(partial).success).toBe(false);
		expect(
			claimObservation({
				path: "api.txt",
				version: v1,
				observation: partial as InputObservation,
			}).source,
		).toBe("unknown");
	}
	const truncated: FootprintUsed = {
		path: "api.txt",
		observation: {
			schemaVersion: 1,
			source: "unknown",
			reason: "返回内容已截断",
		},
	};
	expect(claimObservation(truncated).reason).toContain("截断");
});
test("unstable or incorrectly associated sample cannot establish a file-version binding", () => {
	expect(
		claimObservation({ path: "api.txt", version: v1, observation: observed })
			.binding,
	).toBe("unknown");
	expect(
		claimObservation({
			path: "api.txt",
			version: v2,
			observation: {
				...observed,
				sample: { version: v2, contentHash: v1, stable: false },
			},
		}).binding,
	).toBe("unknown");
});

test("a returned range cannot be attached to a different footprint selector", () => {
	const range: InputObservation = {
		...observed,
		selector: { kind: "lines", start: 1, end: 2 },
	};
	expect(
		claimObservation({
			path: "api.txt",
			version: v2,
			span: { start: 3, end: 4 },
			observation: range,
		}).source,
	).toBe("unknown");
	expect(
		claimObservation({
			path: "api.txt",
			version: v2,
			span: { start: 1, end: 2 },
			observation: range,
		}).source,
	).toBe("tool-observed");
	expect(
		claimObservation({
			path: "api.txt",
			version: v2,
			span: { start: 1, end: 2 },
			observation: observed,
		}).source,
	).toBe("unknown");
});
test("read fragments retain path, range, acting writer and event identity without upgrading old logs", () => {
	const observation: InputObservation = {
		...observed,
		selector: { kind: "lines", start: 1, end: 2 },
	};
	const view = foldReadSet([
		{
			seq: 7,
			eventSeq: 42,
			eventId: "evt",
			timestamp: "2026-10-25T10:00:00Z",
			activity: "read",
			agent: "subagent",
			used: [
				{
					path: "api.txt",
					version: v2,
					span: { start: 1, end: 2, hash: v1 },
					observation,
				},
				{ path: "legacy.txt", version: v1 },
			],
			generated: [],
		},
	]);
	const read = view.readFragments.get("api.txt")![0]!;
	expect([
		read.path,
		read.span?.start,
		read.seq,
		read.eventSeq,
		read.actingAgent,
		read.eventId,
	]).toEqual(["api.txt", 1, 7, 42, "subagent", "evt"]);
	expect(read.observation).toEqual(observation);
	expect(claimObservation(view.reads.get("legacy.txt")!).source).toBe(
		"unknown",
	);
});
