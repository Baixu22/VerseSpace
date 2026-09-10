import type { WorkbenchEvent } from "../../src/types/event";

export interface FamilyNotice {
	noticeId: string;
	writer: string;
	stale: Array<{ path: string; currentVersion: string | null }>;
	familyFold?: { familyId: string; paths: string[]; writerIds: string[] };
}

/** Compare a captured queue entry with later public CLI/log observations. */
export function noticeTransition(
	before: FamilyNotice,
	pending: FamilyNotice[],
	events: WorkbenchEvent[],
) {
	const delivered = events.find((event) => {
		const payload = event.payload as {
			writer?: string;
			noticeId?: string;
			noticeIds?: string[];
		};
		return (
			event.type === "premise_notice_delivered" &&
			payload.writer === before.writer &&
			(payload.noticeId === before.noticeId ||
				payload.noticeIds?.includes(before.noticeId))
		);
	});
	const remaining = pending.find((notice) => notice.writer === before.writer);
	if (
		!delivered &&
		!before.stale.every((claim) =>
			remaining?.stale.some(
				(current) =>
					current.path === claim.path &&
					current.currentVersion === claim.currentVersion,
			),
		)
	)
		throw new Error(
			`通知消失且无独立投递记录：${before.writer}/${before.noticeId}`,
		);

	// Acknowledgement happens after the turn. Inspect reads from the captured
	// pending state onwards, including repairs before that acknowledgement.
	const repairedPaths = before.stale.filter((claim) => {
		let version: string | null | undefined;
		for (const event of events) {
			const payload = event.payload as {
				writer?: string;
				used?: Array<{ path: string; version?: string | null }>;
			};
			if (event.type !== "footprint" || payload.writer !== before.writer)
				continue;
			for (const read of payload.used ?? [])
				if (read.path === claim.path) version = read.version;
		}
		return version !== undefined && version === claim.currentVersion;
	});
	return {
		writer: before.writer,
		noticeId: before.noticeId,
		delivery: delivered ? "delivered" : "pending",
		deliveryEventId: delivered?.id ?? null,
		premise:
			repairedPaths.length === before.stale.length
				? "repaired"
				: "not-proven-repaired",
		repairedPaths: repairedPaths.map((claim) => claim.path),
	};
}
