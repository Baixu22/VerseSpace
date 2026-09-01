import type { CheckpointLifecycle } from "./checkpoint";
import type { GoalStatus } from "./goal";
import type { TribunalEnvelope } from "./tribunal";
import type { WorkspotStatus } from "./workspot";

/**
 * Automaton output (skeleton section 六). The evaluator in milestone four is a
 * pure function: WorldSnapshot in, Transition[] out. Runtime applies each
 * transition through the Blackboard.
 *
 * `workspot_status` extends the skeleton's union (extension point 4): the
 * workspot machine must be able to express status changes (e.g. releasing a
 * workspot whose task completed), and the skeleton's list has no equivalent.
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
	| {
			type: "workspot_status";
			wsId: string;
			from: WorkspotStatus;
			to: WorkspotStatus;
			reason: string;
	  }
	| { type: "enqueue_goal"; goalId: string }
	| { type: "dequeue_goal"; goalId: string }
	| { type: "mark_stale"; goalId: string; reason: string }
	| { type: "request_verification"; cpId: string }
	| { type: "refresh_context"; wsId: string }
	| {
			type: "notify_human";
			message: string;
			severity: "info" | "warning" | "error";
			/**
			 * R3 / TF-0081: the structured form the adjudication queue consumes.
			 * The emitter is the only place that knows what the event is about,
			 * what a human would do differently, and what happens if nobody
			 * acts — so the envelope is built here, not parsed out of `message`
			 * downstream. An emitter without one is a plain log line, never an
			 * alarm.
			 */
			tribunal?: TribunalEnvelope;
	  }
	| {
			/**
			 * R2: deliver a premise-invalidation notice INTO a live writer's
			 * session (the agent-side mirror of notify_human). The automaton
			 * only names the target; the runtime owns actual delivery (it
			 * alone knows which sessions are alive and how to reach them).
			 */
			type: "notify_session";
			writerId: string;
			message: string;
			/** File-level stale-premise evidence attached to the notice. */
			stale: Array<{
				path: string;
				observedVersion: string | null;
				currentVersion: string | null;
				diff?: string;
			}>;
	  };
