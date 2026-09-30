import { expect, test } from "bun:test";
import { hashText } from "../hash";
import type { WorkbenchEvent } from "../types/event";
import { foldNoticeEvidence, noticeEvidence } from "./notice-evidence";

const old = hashText("old"),
	fresh = hashText("fresh"),
	artifact = hashText("artifact");
function timeline(
	read: string | null,
	write?: string,
	verify = false,
): WorkbenchEvent[] {
	const at = "2026-10-01T01:00:00Z";
	const review = {
		rootId: "cp",
		checkpointId: "cp",
		path: "consumer.ts",
		writerId: "w",
		inputs: ["api.ts"],
		origin: { files: { "consumer.ts": artifact } },
	};
	return [
		{ type: "artifact_validity", payload: { ...review, status: "stale" } },
		{
			type: "premise_stale",
			payload: {
				writer: "w",
				noticeId: "n",
				stale: [
					{ path: "api.ts", observedVersion: old, currentVersion: fresh },
				],
			},
		},
		{
			type: "premise_notice_delivered",
			payload: {
				writer: "w",
				noticeIds: ["n"],
				readObservability: "footprint",
			},
		},
		{
			type: "footprint",
			payload: {
				writer: "w",
				used: read ? [{ path: "api.ts", version: read }] : [],
				generated: write ? [{ path: "consumer.ts", version: write }] : [],
			},
		},
		...(verify
			? [
					{
						type: "artifact_validity",
						payload: {
							...review,
							status: "current",
							checkedAt: at,
							verifiedAt: {
								files: { "api.ts": fresh, "consumer.ts": artifact },
							},
						},
					},
				]
			: []),
	].map((event, i) => ({
		...event,
		id: `e${i}`,
		eventSeq: i + 1,
		timestamp: at,
		source: "test",
	}));
}

test("old-version reread and no-op write cannot count as new version, artifact modification or verification", () => {
	const rows = noticeEvidence(timeline(old, artifact));
	expect(rows[0]?.observations).toEqual({
		reread: "observed",
		observedNewVersion: "notObserved",
		artifactModified: "notObserved",
		scopeVerified: "notObserved",
	});
	const changed = noticeEvidence(timeline(fresh, hashText("modified")))[0]!;
	expect(changed.observations.observedNewVersion).toBe("observed");
	expect(changed.observations.artifactModified).toBe("observed");
	expect(changed.observations.scopeVerified).toBe("notObserved");
});

test("declared current-input verification can succeed without an artificial write; dimensions overlap", () => {
	const events = timeline(fresh, undefined, true);
	expect(noticeEvidence(events)[0]?.observations).toEqual({
		reread: "observed",
		observedNewVersion: "observed",
		artifactModified: "notObserved",
		scopeVerified: "observed",
	});
	const totals = foldNoticeEvidence(events);
	expect(totals.denominator).toBe(1);
	for (const counts of Object.values(totals.dimensions))
		expect(counts.observed + counts.notObserved + counts.unknown).toBe(1);
	const verified = events.at(-1)!;
	(verified.payload as Record<string, unknown>).checkedAt =
		"2026-09-01T00:00:00Z";
	expect(noticeEvidence(events)[0]?.observations.scopeVerified).toBe(
		"notObserved",
	);
});

test("unobservable, weak versions and missing artifact relations stay unknown", () => {
	const events = timeline(fresh).filter(
		(event) => event.type !== "artifact_validity",
	);
	const delivery = events.find(
		(event) => event.type === "premise_notice_delivered",
	)!;
	(delivery.payload as Record<string, unknown>).readObservability =
		"unobservable";
	expect(noticeEvidence(events)[0]?.observations).toEqual({
		reread: "unknown",
		observedNewVersion: "unknown",
		artifactModified: "unknown",
		scopeVerified: "unknown",
	});
});
