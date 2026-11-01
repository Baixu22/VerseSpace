/** 服务端通过 factsPreviewCount 下发事实预览条数，前端直接消费。 */
export const FACTS_PREVIEW_COUNT = 3;

export type ConflictRule =
	| "R1"
	| "R2"
	| "R3"
	| "R4"
	| "R5"
	| "R6"
	| "R7"
	| "R8"
	| "R9"
	// Card rule R10 (TF-0151), not product constraint R10 in docs/fable-brief.
	| "R10";

export interface ClaimObservation {
	path: string;
	claimedVersion?: string | null;
	preWriteVersion?: string | null;
	movedTo?: string | null;
}

export interface RepoFact {
	path: string;
	currentVersion: string | null;
	writerId?: string | null;
	writerLabel?: string | null;
	refs: string[];
}

export interface ConflictAnnotation {
	rule: ConflictRule;
	label: string;
}

export interface NarrativeRow {
	kind: "doing" | "decided" | "next";
	text: string;
	refs: string[];
	annotation?: ConflictAnnotation;
}

export interface FactRow {
	path: string;
	summary: string;
	refs: string[];
	observedVersion?: string;
	currentVersion?: string | null;
	writerId?: string | null;
	writerLabel?: string | null;
	diff?: string;
	annotation?: ConflictAnnotation;
	/**
	 * `interruption` = 会话回合被切断且没有回复（TF-0324）。它与文件事实共用
	 * `FactRow` 形状，所以 refs/展开/证据接口全部复用，不另造一种行。
	 */
	source: "read-set" | "shifted" | "branch" | "interruption";
	branch?: {
		threadId: string;
		anchorMessageId: string;
		paths: string[];
		newForks: number;
	};
}

export interface ResumeCardView {
	/**
	 * The facts section's first line (TF-0129): how much of the read set could
	 * actually be checked. It is its own field rather than `facts[0]` so no
	 * preview cut can push it out of view and so it never consumes one of the
	 * `FACTS_PREVIEW_COUNT` slots.
	 */
	coverage: CoverageRow;
	narrative: NarrativeRow[];
	facts: FactRow[];
	/**
	 * 钉在预览之外的事实行数（TF-0323 判据 4）：会话断点必须先于文件事实
	 * 可见，不能被 `factsPreviewCount` 折叠掉。客户端按这个数字只在
	 * 「及另 N 条」之外单独渲染前 N 条，折叠规则其余部分不变。
	 */
	pinnedFacts: number;
	dismissed: boolean;
	/** Auto-inject into the restore surface. False after one dismiss. */
	inject: boolean;
	/**
	 * 折叠前展示几条事实（= `FACTS_PREVIEW_COUNT`）。随载荷下发，客户端直接
	 * 读它——客户端不再自带一份同值常量（2026-09-13 收尾 §5.6）。
	 */
	factsPreviewCount: number;
}

export interface CoverageRow {
	/** `unknown` whenever no honest ratio exists — never a reassuring default. */
	status: "available" | "unknown";
	compared: number;
	comparable: number;
	changed: number;
	excludedDurable: number;
	excludedDirectories: number;
	unsupported: number;
	uncoveredTools: string[];
	/** Rendered line. Always non-empty; never claims nothing changed. */
	text: string;
}
