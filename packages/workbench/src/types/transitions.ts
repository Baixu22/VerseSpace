import type { CheckpointLifecycle } from "./checkpoint";
import type { GoalStatus } from "./goal";

/**
 * Automaton output (skeleton section 六). The evaluator in milestone four is a
 * pure function: WorldSnapshot in, Transition[] out. Runtime applies each
 * transition through the Blackboard.
 */
export type Transition =
	| {
			type: "goal_status";
			goalId: string;
			from: GoalStatus;
			to: GoalStatus;
			reason: string;
	  }
	| {
			type: "checkpoint_lifecycle";
			cpId: string;
			from: CheckpointLifecycle;
			to: CheckpointLifecycle;
	  }
	| { type: "enqueue_goal"; goalId: string }
	| { type: "mark_stale"; goalId: string; reason: string }
	| { type: "request_verification"; cpId: string }
	| { type: "refresh_context"; wsId: string }
	| {
			type: "notify_human";
			message: string;
			severity: "info" | "warning" | "error";
	  };
