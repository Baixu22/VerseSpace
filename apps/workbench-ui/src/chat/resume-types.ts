export interface ResumeBeat {
	kind: "doing" | "decided" | "shifted" | "next";
	text: string;
	refs?: string[];
}

export interface ResumeNote {
	beats: ResumeBeat[];
	draftedAt: string;
	confirmedAt?: string;
	leaveSignature: {
		lastMessageAt: string;
		messageCount: number;
		footprintSeq?: number;
		eventSeq?: number;
		eventId?: string;
	};
}

export interface ReadSetDiffFact {
	path: string;
	observedVersion: string;
	currentVersion: string | null;
	writerId: string | null;
	writerKind: string | null;
	writerLabel: string | null;
	diff?: string;
	refs: string[];
	observedFootprintSeq: number;
	currentEventSeq: number | null;
}

export interface ResumeCardAnnotation {
	rule: "R1" | "R2" | "R3" | "R4" | "R5" | "R6" | "R7" | "R8" | "R9" | "R10";
	label: string;
}

export interface ResumeCardNarrativeRow {
	kind: "doing" | "decided" | "next";
	text: string;
	refs: string[];
	annotation?: ResumeCardAnnotation;
}

export interface ResumeCardFactRow {
	path: string;
	summary: string;
	refs: string[];
	observedVersion?: string;
	currentVersion?: string | null;
	writerId?: string | null;
	writerLabel?: string | null;
	diff?: string;
	annotation?: ResumeCardAnnotation;
	source: "read-set" | "shifted" | "branch";
	branch?: {
		threadId: string;
		anchorMessageId: string;
		paths: string[];
		newForks: number;
	};
}

export type ArtifactReviewStatus =
	| "current"
	| "stale"
	| "pending"
	| "failed"
	| "unknown";

export interface ArtifactReviewProjectionItem {
	rootId: string;
	checkpointId: string;
	path: string;
	status: ArtifactReviewStatus;
	reason: string;
	targetStatus: "target-checked" | "inputs-match" | "inputs-differ" | "unknown";
	evidenceStrength: "observed-origin-and-scope" | "declared-scope" | "unknown";
	refs: string[];
	revalidateCommand: string;
	handoff?: {
		digest: string;
		checkpointHash: string;
		originStrength: string;
		targetStatus: string;
	};
	facts: {
		origin: {
			strength: "tool-observed" | "fs-sample" | "declared" | "unknown";
			reason: string;
		};
		inputs: {
			status: "matched" | "different" | "unknown";
			total: number;
			changedTotal: number;
			previewTruncated: boolean;
			changed: string[];
			versions: Array<{ path: string; hash: string }>;
		};
		verification: {
			checkpointId: string;
			result: string | null;
			scope: string;
			authority: string;
			at: string | null;
		};
	};
	target: {
		status: ArtifactReviewProjectionItem["targetStatus"];
		change:
			| "none"
			| "outside-declared-range"
			| "revalidation-required"
			| "unknown";
		ref: string | null;
		checkedCommit: string | null;
		currentCommit: string | null;
	};
}

export interface ArtifactReviewProjectionView {
	schemaVersion: 1;
	total: number;
	counts: Record<ArtifactReviewStatus, number>;
	items: ArtifactReviewProjectionItem[];
	omitted: number;
	truncated: boolean;
}

export interface ResumeCardView {
	coverage: { status: "available" | "unknown"; text: string };
	narrative: ResumeCardNarrativeRow[];
	facts: ResumeCardFactRow[];
	dismissed: boolean;
	inject: boolean;
	/**
	 * 折叠前展示几条事实。由服务端随载荷下发（`FACTS_PREVIEW_COUNT` 的
	 * 唯一来源在 packages/workbench/src/chat/resume-card/types.ts）——
	 * 客户端不再自带一份同值常量（2026-09-13 收尾 §5.6）。
	 */
	factsPreviewCount: number;
}

export interface ReadSetDiff {
	status: "available" | "unknown";
	baseline: {
		footprintSeq: number;
		eventSeq: number | null;
		eventId: string | null;
	} | null;
	checkedAt: string;
	compared: number;
	comparable: number;
	excludedDurable: number;
	unsupported: number;
	uncoveredTools: string[];
	stale: ReadSetDiffFact[];
}
