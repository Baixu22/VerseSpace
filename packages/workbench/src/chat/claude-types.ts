import type { ParsedStreamFootprint } from "../blackboard/footprint";

import type { LivenessWatch, ProcHandle } from "../supervisor";

import type { ClaudeRenderState } from "./claude-render-state";
import type { ForkAgentPlan } from "./fork";
import type { TurnRunEvent } from "./thread-types";

export interface ActiveTurn extends ClaudeRenderState {
	/**
	 * TF-0206: event paths this turn did not have a render decision for. Paths
	 * include nested stream/content types so SDK additions cannot hide under a
	 * known top-level envelope.
	 */
	undecidedEventTypes: Set<string>;
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
	emit: (event: TurnRunEvent) => void;
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
