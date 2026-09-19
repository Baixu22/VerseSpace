import type {
	LandmarkAcceptance,
	RelativeLandmarkCoverage,
} from "../interactions/review-stats";
import type { NoticeOutcomeTotals } from "../runtime/notice-outcome";
import type { PremisePassTotals } from "../runtime/premise-counts";
import type { SealTotals } from "../runtime/seal-counts";
import type { SealReviewTotals } from "../runtime/seal-review";
import type { RestoreTimingStats } from "./restore-timing";
import type { ResumeCardCircuitState } from "./resume-card/circuit";

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
		/**
		 * 恢复卡熔断器读数（TF-0198）：与渲染路径共用同一投影——open 即分支行
		 * 正在降为 L0 指针；窗口内行为变好则自动回到 closed（可恢复，无需手势）。
		 */
		resumeCardCircuit: ResumeCardCircuitState;
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
		/**
		 * L1 主读数（TF-0159 新口径）：每会话文件级 top-K，叠加种类门。
		 * 判据是「集合里 ≥80% 是用户认可的核心」，所以分母是所有候选条目，
		 * `reviewedCoverage` 单列——只复核两条就说 80% 是在骗自己。
		 */
		current: LandmarkAcceptance;
		/**
		 * 旧口径读数（阈值口径，历史可比）：双读数期并报一个周期，口径切换带来的
		 * 跳变因此可归因。字段自带 `denominator`，读数不用靠字段名猜尺子。
		 */
		threshold: LandmarkAcceptance;
		/**
		 * 代理自审口径（读法同 current，但只收 steward 来源）。**不是用户认可**：
		 * 没有真人时它让这条链路仍然可读、可监控，human 那格照旧空着。
		 */
		steward: LandmarkAcceptance;
		/**
		 * **未过滤对照**（`requireEdits: false` 显式回滚，翻默认前的旧定义）：
		 * 2026-09-11 已把「只认可落笔（含只读会话豁免）」翻成默认——`current`
		 * 从此就是过滤后的读数，这一栏留作对照，与 current 的差距即被过滤的
		 * 纯浏览噪声。并报一个周期后撤。
		 */
		unfiltered: LandmarkAcceptance;
		/** 相对选择的可计量性：有文件级触碰的会话里，多少能排出非空的 top-K。 */
		coverage: RelativeLandmarkCoverage;
	};
	dataQuality: {
		insufficientHistory: boolean;
		reasons: string[];
	};
}
