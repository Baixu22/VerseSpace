import type { Blackboard } from "../blackboard";
import { checkAdoption } from "./checks/adoption";
import { checkCheckpoints } from "./checks/checkpoints";
import { checkAutoCap, checkProtectionConfig } from "./checks/config";
import { checkDrafts } from "./checks/drafts";
import { checkGoals } from "./checks/goals";
import { checkInterfaces } from "./checks/interfaces";
import { checkQueue } from "./checks/queue";
import { checkWorkspots } from "./checks/workspots";
import type { DoctorContext, DoctorIssue, DoctorReport } from "./types";

export type { DoctorIssue, DoctorReport } from "./types";

/**
 * doctor (skeleton Phase 7): full consistency sweep over the blackboard.
 * Read-only — it reports, it never repairs (sync is the repair path).
 */
export async function runDoctor(bb: Blackboard): Promise<DoctorReport> {
	const issues: DoctorIssue[] = [];

	const [goals, workspots, interfaces, queue, staging, verified, failed] =
		await Promise.all([
			bb.goals.list(),
			bb.state.workspots.list(),
			bb.interfaces.list(),
			bb.state.queue.get(),
			bb.checkpoints.scanZone("staging"),
			bb.checkpoints.scanZone("verified"),
			bb.checkpoints.scanZone("failed"),
		]);

	const ctx: DoctorContext = {
		goals,
		workspots,
		interfaces,
		queue,
		staging,
		verified,
		failed,
		goalIds: new Set(goals.map((goal) => goal.id)),
	};

	checkGoals(ctx, issues);
	checkCheckpoints(ctx, issues);
	checkWorkspots(ctx, issues);
	checkQueue(ctx, issues);
	await checkInterfaces(bb, ctx, issues);
	checkDrafts(ctx, issues);

	const config = await bb.config.load();
	checkAutoCap(config, issues);
	await checkAdoption(bb, issues);
	await checkProtectionConfig(bb, config, issues);

	return { ok: issues.every((issue) => issue.severity !== "error"), issues };
}
