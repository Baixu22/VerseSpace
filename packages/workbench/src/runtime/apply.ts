import type { Blackboard } from "../blackboard";
import { generateContext } from "../contextgen/generate";
import type { Transition } from "../types/transitions";
import { applyCheckpoint } from "./checkpoint-effects";
import { event } from "./events";
import type {
	RunOnceResult,
	RuntimeNotification,
	TribunalTally,
} from "./types";
import {
	invalidateVerification,
	verificationStalenessReason,
} from "./verification-binding";
import { verifyCheckpoint } from "./verify-checkpoint";

/**
 * Offer one emitter's event to the adjudication queue. `notify_human` used to
 * end here — pushed into an array the runtime returned and nobody owned. Now
 * the queue decides whether it is an alarm at all, whether it is a twin of
 * something already queued, and whether a human owes it a decision today.
 *
 * An emitter with no envelope is a plain log line: it keeps its place in
 * `notifications` and the event log, and never reaches a human.
 */
async function offerToTribunal(
	bb: Blackboard,
	transition: Transition & { type: "notify_human" },
	tally: TribunalTally,
	at: string,
): Promise<void> {
	if (!transition.tribunal) {
		return;
	}
	tally.submitted += 1;
	const result = await bb.tribunal.submit({ ...transition.tribunal, at });
	if (result.admitted) {
		tally.admitted += 1;
		if (result.folded) {
			tally.folded += 1;
		}
		return;
	}
	tally.suppressed += 1;
}

export async function applyTransition(
	bb: Blackboard,
	transition: Transition,
	notifications: RuntimeNotification[],
	verifications: RunOnceResult["verifications"],
	tally: TribunalTally,
): Promise<boolean> {
	switch (transition.type) {
		case "goal_status": {
			const goal = await bb.goals.get(transition.goalId);
			if (!goal || goal.status !== transition.from) {
				return false;
			}
			if (transition.to === "done") {
				// Anchor the completed goal to every registered interface version
				// at completion time; later version bumps mark it stale (the
				// mark_stale rule reads these anchors).
				const interfaces = Object.fromEntries(
					(await bb.interfaces.list()).map((entry) => [
						entry.key,
						entry.version,
					]),
				);
				await bb.goals.update(transition.goalId, {
					status: "done",
					verifiedAgainst: {
						interfaces,
						decisions: goal.verifiedAgainst.decisions,
					},
				});
			} else {
				await bb.goals.update(transition.goalId, { status: transition.to });
			}
			await event(bb, "goal_status", transition);
			return true;
		}
		case "mark_stale": {
			const goal = await bb.goals.get(transition.goalId);
			if (goal?.status !== "done") {
				return false;
			}
			await bb.goals.update(transition.goalId, {
				status: "stale_done",
				staleReason: transition.reason,
			});
			await event(bb, "mark_stale", transition);
			return true;
		}
		case "enqueue_goal": {
			await bb.state.queue.enqueue(transition.goalId);
			await event(bb, "enqueue_goal", transition);
			return true;
		}
		case "dequeue_goal": {
			await bb.state.queue.dequeue(transition.goalId);
			await event(bb, "dequeue_goal", transition);
			return true;
		}
		case "checkpoint_lifecycle": {
			const verified = (await bb.checkpoints.scanZone("verified")).find(
				(cp) => cp.id === transition.cpId,
			);
			if (!verified || verified.lifecycle !== transition.from) {
				return false;
			}
			// 验证时效性（2026-09-30）：verified→applied 之前重新确认验证依据仍
			// 成立。代码在验证后变化（人编辑、其他 agent、合并）时，这不是「已验证
			// 的效果被应用」，而是旧绿灯放行新代码——退回 staging 重新验证。
			const staleReason = verified.artifact
				? null
				: await verificationStalenessReason(bb, verified);
			if (staleReason) {
				await invalidateVerification(bb, verified, staleReason, notifications);
				return true;
			}
			await applyCheckpoint(bb, verified, notifications);
			return true;
		}
		case "workspot_status": {
			const workspot = await bb.state.workspots.get(transition.wsId);
			if (!workspot || workspot.status !== transition.from) {
				return false;
			}
			await bb.state.workspots.save({
				...workspot,
				status: transition.to,
				// releasing a workspot clears its borrowed assignment
				currentTask:
					transition.to === "idle" ? undefined : workspot.currentTask,
			});
			await event(bb, "workspot_status", transition);
			return true;
		}
		case "refresh_context": {
			const result = await generateContext(bb, transition.wsId);
			await event(bb, "refresh_context", {
				wsId: transition.wsId,
				ok: result.ok,
				reason: result.reason,
			});
			return true;
		}
		case "request_verification":
			return verifyCheckpoint(bb, transition.cpId, verifications);
		case "notify_human": {
			const at = new Date().toISOString();
			notifications.push({
				message: transition.message,
				severity: transition.severity,
			});
			await event(bb, "notify_human", transition);
			await offerToTribunal(bb, transition, tally, at);
			return true;
		}
		case "notify_session": {
			// the automaton only NAMES the target; actual delivery into the
			// live session is reconciliation's job (it knows what is alive)
			await event(bb, "notify_session", {
				writer: transition.writerId,
				message: transition.message,
				stale: transition.stale,
			});
			return true;
		}
	}
}
