import type { WorkbenchEvent } from "../types/event";
import { interestFromEvents } from "./context";
import {
	collectLandmarkReviews,
	type LandmarkReview,
	landmarkReviewJudgement,
} from "./review";
import { INTERACTIONS_SOURCE, INTERACTIONS_TYPE } from "./types";

type Judgement = ReturnType<typeof landmarkReviewJudgement>;
export type LandmarkAcceptance = Judgement & {
	byWriter: Array<Judgement & { writer: string }>;
};

/** Each (writer, handle) is one current landmark; repeated reviews are corrections. */
export function currentLandmarkAcceptance(
	events: WorkbenchEvent[],
	writerIds: string[],
	now = Date.now(),
): LandmarkAcceptance {
	const records = new Map(
		writerIds.map((writer) => [writer, [] as WorkbenchEvent[]]),
	);
	for (const event of events) {
		if (
			event.source !== INTERACTIONS_SOURCE ||
			event.type !== INTERACTIONS_TYPE
		)
			continue;
		const writer = (event.payload as { origin?: string } | null)?.origin;
		if (writer) records.get(writer)?.push(event);
	}
	const reviews = new Map<string, LandmarkReview[]>();
	for (const review of collectLandmarkReviews(events)) {
		const bucket = reviews.get(review.writer) ?? [];
		bucket.push(review);
		reviews.set(review.writer, bucket);
	}
	const byWriter = [...records].map(([writer, rows]) => ({
		writer,
		...landmarkReviewJudgement(
			interestFromEvents(rows, writer, now).landmarks,
			reviews.get(writer) ?? [],
		),
	}));
	const totals = byWriter.reduce(
		(sum, row) => ({
			total: sum.total + row.total,
			reviewed: sum.reviewed + row.reviewed,
			endorsed: sum.endorsed + row.endorsed,
			rejected: sum.rejected + row.rejected,
		}),
		{ total: 0, reviewed: 0, endorsed: 0, rejected: 0 },
	);
	return {
		...totals,
		endorsedShare: totals.total > 0 ? totals.endorsed / totals.total : null,
		reviewedCoverage: totals.total > 0 ? totals.reviewed / totals.total : null,
		byWriter,
	};
}
