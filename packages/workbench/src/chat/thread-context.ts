import type { Blackboard } from "../blackboard";

import type { ProcHandle } from "../supervisor";

import type { LiveClaudeSession } from "./claude-types";
import type { LiveCodexSession } from "./codex-session";

import type { ThreadRepository } from "./thread-repository";
export interface ThreadContext {
	bb: Blackboard;
	store: ThreadRepository;
	running: Map<string, ProcHandle | AbortController>;
	live: Map<string, LiveClaudeSession>;
	/** TF-0249: codex lane sessions, kept separate from the claude `live` map
	 *  because the two providers have different session shapes and lifecycles. */
	liveCodex: Map<string, LiveCodexSession>;
	observingInheritance: Set<string>;
	lineRouters: Map<string, (line: string) => void>;
	pendingVariants: Map<string, string[]>;
}
