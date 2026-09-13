/**
 * 恢复卡事实条目数。⚠ UI 侧 apps/workbench-ui/src/components/chat/resume-card.tsx
 * 有同值重声明（=3）——两端构建独立，无法共享 import；改动时必须同步（2026-09-13 收尾 4.2）。
 */
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
	source: "read-set" | "shifted" | "branch";
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
	dismissed: boolean;
	/** Auto-inject into the restore surface. False after one dismiss. */
	inject: boolean;
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
