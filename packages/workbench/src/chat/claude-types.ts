import type { ParsedStreamFootprint } from "../blackboard/footprint";

import type { LivenessWatch, ProcHandle } from "../supervisor";

import type { ForkAgentPlan } from "./fork";
import type { MessagePart, RunEvent } from "./thread-types";

export interface ActiveTurn {
	assistantTexts: string[];
	messageParts: MessagePart[];
	stderr: string;
	pendingFootprints: Map<string, ParsedStreamFootprint>;
	fpQueue: Promise<void>;
	sawInit: boolean;
	finished: boolean;
	noticeAcked: boolean;
	noticeAckPromise: Promise<void>;
	noticeCount: number;
	onNoticesSent?: () => Promise<boolean>;
	inheritanceStarted: boolean;
	inheritancePromise: Promise<void>;
	emit: (event: RunEvent) => void;
	resolve: () => void;
}

export interface LiveClaudeSession {
	proc: ProcHandle;
	/**
	 * TF-0205: silence/broken-pipe watch over this child. Present for the whole
	 * lifetime of the session; turn code reports a failed stdin write here so a
	 * broken pipe is a named outcome instead of a bare exception.
	 */
	liveness?: LivenessWatch;
	claudeSessionId: string | undefined;
	turn: ActiveTurn | null;
	/** Lines emitted before the first turn is attached (startup race buffer). */
	initialLines: string[];
	bufferInitialLines: boolean;
	/** Whether this process was started with --fork-session. */
	agentContextMode: "fresh" | "fork-session";
	forkPlan?: ForkAgentPlan;
	idleTimer?: ReturnType<typeof setTimeout>;
	/** Process exit and asynchronous finalization share one completion boundary. */
	closing?: boolean;
	closed?: Promise<void>;
}
