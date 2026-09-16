import type { Blackboard } from "../blackboard";

import type { ProcHandle } from "../supervisor";

import type { LiveClaudeSession } from "./claude-types";

import type { ThreadRepository } from "./thread-repository";
export interface ThreadContext {
	bb: Blackboard;
	store: ThreadRepository;
	running: Map<string, ProcHandle | AbortController>;
	live: Map<string, LiveClaudeSession>;
	observingInheritance: Set<string>;
	lineRouters: Map<string, (line: string) => void>;
	pendingVariants: Map<string, string[]>;
}
