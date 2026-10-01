import type { ArtifactReview } from "../artifacts/status";
import type { WorkbenchEvent } from "../types/event";
import { ordered, payloadOf, stringsOf } from "./notice-window";
import { deliveryWindows } from "./notice-windows";

export const EVIDENCE_KINDS = [
	"reread",
	"observedNewVersion",
	"artifactModified",
	"scopeVerified",
] as const;
type EvidenceKind = (typeof EVIDENCE_KINDS)[number];
type Observation = "observed" | "notObserved" | "unknown";
interface Claim {
	path: string;
	version?: string | null;
	observedVersion?: string | null;
	currentVersion?: string | null;
}
const exact = (value: unknown): value is string =>
	typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function claims(value: unknown): Claim[] {
	return Array.isArray(value)
		? value.filter(
				(item): item is Claim => item && typeof item.path === "string",
			)
		: [];
}

/** Compare each write with the latest observed version, including earlier windows. */
function artifactModification(
	timeline: WorkbenchEvent[],
	start: number,
	writer: string,
	paths: Set<string>,
): Observation {
	const versions = new Map<string, string | null | undefined>();
	const artifacts = new Set<string>();
	let unknown = false;
	for (const [index, event] of timeline.entries()) {
		const payload = payloadOf(event);
		if (event.type === "artifact_validity") {
			const review = event.payload as unknown as ArtifactReview;
			if (
				(review.writerId === writer || review.threadId === writer) &&
				review.inputs?.some((path) => paths.has(path))
			) {
				artifacts.add(review.path);
				if (!versions.has(review.path))
					versions.set(
						review.path,
						review.verifiedAt?.files[review.path] ??
							review.origin?.files[review.path],
					);
			}
		}
		if (event.type !== "footprint") continue;
		for (const read of claims(payload.used))
			versions.set(read.path, read.version);
		for (const write of claims(payload.generated)) {
			const before = versions.get(write.path);
			if (
				index >= start &&
				payload.writer === writer &&
				artifacts.has(write.path)
			) {
				if (!exact(before) || !exact(write.version)) unknown = true;
				else if (before !== write.version) return "observed";
			}
			versions.set(write.path, write.version);
		}
	}
	return unknown ? "unknown" : "notObserved";
}

/** Per successful delivery window; these dimensions overlap, and are not repair correctness. */
export function noticeEvidence(events: WorkbenchEvent[]) {
	const timeline = ordered(events);
	const staleById = new Map<string, Claim[]>();
	for (const event of timeline) {
		const payload = payloadOf(event);
		if (event.type === "premise_stale" && typeof payload.noticeId === "string")
			staleById.set(payload.noticeId, claims(payload.stale));
	}
	return deliveryWindows(timeline).map((window) => {
		const delivery = timeline[window.delivery]!;
		const payload = payloadOf(delivery);
		const writer = payload.writer as string;
		const ids = [
			...stringsOf(payload.noticeIds),
			...(typeof payload.noticeId === "string" ? [payload.noticeId] : []),
		];
		const required = [
			...claims(payload.stale),
			...ids.flatMap((id) => staleById.get(id) ?? []),
		];
		const paths = new Set(required.map((claim) => claim.path));
		const windowEvents = timeline.slice(window.start, window.end);
		const footprints = windowEvents.filter(
			(event) =>
				event.type === "footprint" && payloadOf(event).writer === writer,
		);
		const reads = footprints.flatMap((event) => claims(payloadOf(event).used));
		const observable =
			payload.readObservability !== "unobservable" &&
			footprints.length > 0 &&
			paths.size > 0;
		const relations = timeline
			.slice(0, window.end)
			.filter((event) => event.type === "artifact_validity")
			.map((event) => event.payload as unknown as ArtifactReview)
			.filter(
				(review) =>
					(review.writerId === writer || review.threadId === writer) &&
					review.inputs?.some((path) => paths.has(path)),
			);
		const observations: Record<EvidenceKind, Observation> = {
			reread: observable
				? reads.some((read) => paths.has(read.path))
					? "observed"
					: "notObserved"
				: "unknown",
			observedNewVersion:
				observable && required.every((claim) => exact(claim.currentVersion))
					? required.every((claim) =>
							reads.some(
								(read) =>
									read.path === claim.path &&
									read.version === claim.currentVersion,
							),
						)
						? "observed"
						: "notObserved"
					: "unknown",
			artifactModified:
				observable && relations.length > 0 ? "notObserved" : "unknown",
			scopeVerified: relations.length > 0 ? "notObserved" : "unknown",
		};
		if (observable && relations.length > 0)
			observations.artifactModified = artifactModification(
				timeline.slice(0, window.end),
				window.start,
				writer,
				paths,
			);
		const verified = windowEvents.filter((event) => {
			if (event.type !== "artifact_validity") return false;
			const review = event.payload as unknown as ArtifactReview;
			return (
				(review.writerId === writer || review.threadId === writer) &&
				review.status === "current" &&
				Date.parse(review.checkedAt ?? "") >=
					Date.parse(timeline[window.start - 1]!.timestamp) &&
				required.length > 0 &&
				required.every(
					(claim) =>
						exact(claim.currentVersion) &&
						review.inputs?.includes(claim.path) &&
						review.verifiedAt?.files[claim.path] === claim.currentVersion,
				)
			);
		});
		if (verified.length > 0) observations.scopeVerified = "observed";
		return {
			writer,
			at: delivery.timestamp,
			noticeIds: ids,
			observations,
			refs: [
				...new Set(
					[...footprints, ...verified].flatMap((event) =>
						event.id ? [event.id] : [],
					),
				),
			],
		};
	});
}

export function foldNoticeEvidence(events: WorkbenchEvent[]) {
	const rows = noticeEvidence(events);
	const dimensions = Object.fromEntries(
		EVIDENCE_KINDS.map((kind) => [
			kind,
			{ observed: 0, notObserved: 0, unknown: 0 },
		]),
	) as Record<EvidenceKind, Record<Observation, number>>;
	for (const row of rows)
		for (const kind of EVIDENCE_KINDS)
			dimensions[kind][row.observations[kind]] += 1;
	return {
		denominator: rows.length,
		semantics:
			"每项分母为成功送达窗口；各项可重叠，未观察到不代表未发生；不是修复正确率",
		dimensions,
	};
}
