import type { LandmarkAcceptance } from "../interactions/review-stats";
import type { NoticeOutcomeTotals } from "../runtime/notice-outcome";
import type { PremisePassTotals } from "../runtime/premise-counts";
import type { SealTotals } from "../runtime/seal-counts";
import type { SealReviewTotals } from "../runtime/seal-review";
import type { RestoreTimingStats } from "./restore-timing";

export interface ChatStats {
	threads: {
		total: number;
		withMessages: number;
		withFootprints: number;
		withResumeNotes: number;
		forked: number;
		resumeNoteCoverage: number | null;
		footprintCoverage: number | null;
	};
	forks: {
		total: number;
		perWeek: number | null;
		depth: {
			min: number;
			max: number;
			average: number;
		};
		families: {
			count: number;
			largestSize: number;
		};
	};
	observation: {
		startedAt: string | null;
		endedAt: string | null;
		days: number;
	};
	lifecycle: {
		switches: number;
		restores: number;
		resumeNotesConsumed: number;
		resumeActions: number;
		restoreToMessage: RestoreTimingStats;
		restoreFirstAction: {
			observed: number;
			known: number;
			unknown: number;
			byKind: Record<string, number>;
		};
	};
	siblingAlternation: {
		available: boolean;
		reason: string;
		/** All fork families, including ones without observed sibling switches. */
		families: number;
		/** Distinct root families with two connected transitions in one window. */
		alternatingFamilies: number;
		rate: number | null;
		transitions: number;
		windowMinutes: number;
	};
	/** R2 predicate accounting (TF-0149): where candidate claims died. */
	premises: PremisePassTotals;
	/**
	 * Seal decisions (TF-0134): hits, blocks, and what was let through —
	 * plus the human review totals that close the calibration loop. A block
	 * proves a refusal happened; only `reviews.correct` makes it "且事后判定
	 * 为正确封印" (moat C's full threshold).
	 */
	seal: SealTotals & { reviews: SealReviewTotals };
	/**
	 * The calibration table (TF-0148): agent-side notice outcomes beside the
	 * human-side resume-card actions. Both columns come from the same log.
	 */
	noticeOutcomes: NoticeOutcomeTotals;
	/**
	 * 近 7 天窗口的伴随读数（TF-0149）：聚合 notifiedRatio 随空闲重查的
	 * dedup 累积自然衰减，窗口读数反映当前谓词健康度；聚合口径不变。
	 */
	premisesRecent: {
		windowDays: number;
		passes: number;
		overlaps: number;
		notified: number;
		ratio: number | null;
	};
	/** 人工地标复核计数（TF-0154）：L1 验收「80% 用户认可」的数据源。 */
	landmarkReviews: {
		endorsed: number;
		rejected: number;
		lastAt: string | null;
		/** Full current sets, separate from the raw feedback-event counts above. */
		current: LandmarkAcceptance;
	};
	dataQuality: {
		insufficientHistory: boolean;
		reasons: string[];
	};
}
