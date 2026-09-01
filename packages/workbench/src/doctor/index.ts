import type { Blackboard } from "../blackboard";

export interface DoctorIssue {
	/** machine-readable check id, e.g. dangling_dependency */
	check: string;
	severity: "error" | "warning";
	message: string;
	/** Where to look: goal id, checkpoint id, key, path... */
	subject?: string;
}

export interface DoctorReport {
	ok: boolean;
	issues: DoctorIssue[];
}

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

	// ── goals: DAG integrity ──
	const goalIds = new Set(goals.map((goal) => goal.id));
	for (const goal of goals) {
		for (const dep of goal.dependsOn) {
			if (!goalIds.has(dep)) {
				issues.push({
					check: "dangling_dependency",
					severity: "error",
					message: `目标 ${goal.id} 依赖不存在的目标 ${dep}（从 dependsOn 中移除或补建目标）`,
					subject: goal.id,
				});
			}
		}
		// declared checkpoints must exist somewhere
		const knownCheckpoints = new Set(
			[...staging, ...verified, ...failed].map((cp) => cp.id),
		);
		for (const cpId of goal.checkpoints) {
			if (!knownCheckpoints.has(cpId)) {
				issues.push({
					check: "dangling_checkpoint_reference",
					severity: "warning",
					message: `目标 ${goal.id} 引用的 checkpoint ${cpId} 在任何分区都找不到（可能被手工删除）`,
					subject: goal.id,
				});
			}
		}
		// drift anchors: interface must exist and be at the anchored version
		for (const [key, version] of Object.entries(
			goal.verifiedAgainst.interfaces,
		)) {
			const entry = interfaces.find((candidate) => candidate.key === key);
			if (!entry) {
				issues.push({
					check: "unknown_interface_anchor",
					severity: "warning",
					message: `目标 ${goal.id} 锚定的接口 ${key} 不在注册表中`,
					subject: goal.id,
				});
			} else if (entry.version < version) {
				issues.push({
					check: "registry_version_regression",
					severity: "error",
					message: `接口 ${key} 注册表版本（v${entry.version}）低于目标 ${goal.id} 的锚定版本（v${version}），注册表可能被手工改坏`,
					subject: key,
				});
			}
		}
	}

	// ── checkpoints: orphans and zone/lifecycle mismatch ──
	const _zoneOf = (cpId: string) =>
		staging.some((cp) => cp.id === cpId)
			? "staging"
			: verified.some((cp) => cp.id === cpId)
				? "verified"
				: failed.some((cp) => cp.id === cpId)
					? "failed"
					: null;
	for (const checkpoint of [...staging, ...verified, ...failed]) {
		if (!goalIds.has(checkpoint.goal)) {
			issues.push({
				check: "orphan_checkpoint",
				severity: "error",
				message: `checkpoint ${checkpoint.id} 指向不存在的目标 ${checkpoint.goal}（删除该文件或补建目标）`,
				subject: checkpoint.id,
			});
		}
		if (!workspots.some((ws) => ws.id === checkpoint.workspot)) {
			issues.push({
				check: "orphan_checkpoint_workspot",
				severity: "warning",
				message: `checkpoint ${checkpoint.id} 指向不存在的工位 ${checkpoint.workspot}`,
				subject: checkpoint.id,
			});
		}
	}

	// ── workspots: task references and queue/status contradictions ──
	for (const workspot of workspots) {
		const taskId = workspot.currentTask ?? workspot.primaryTask;
		if (!goalIds.has(taskId)) {
			issues.push({
				check: "dangling_workspot_task",
				severity: "error",
				message: `工位 ${workspot.id} 指向不存在的目标 ${taskId}（ws reassign 或删除工位）`,
				subject: workspot.id,
			});
		} else if (workspot.status === "active") {
			const task = goals.find((goal) => goal.id === taskId);
			if (
				task &&
				(task.status === "cancelled" || task.status === "stale_done")
			) {
				// the automaton will emit the block transition on next sync; doctor
				// surfaces it as informational context for the human
				issues.push({
					check: "active_on_dead_task",
					severity: "warning",
					message: `工位 ${workspot.id} 活跃于已失效目标 ${taskId}（${task.status}）——sync 将阻塞该工位`,
					subject: workspot.id,
				});
			}
		}
	}

	// ── queue: entries must be ready goals; duplicates are corruption ──
	const seen = new Set<string>();
	for (const goalId of queue) {
		if (seen.has(goalId)) {
			issues.push({
				check: "duplicate_queue_entry",
				severity: "error",
				message: `执行队列中目标 ${goalId} 重复出现（队列文件可能被手工编辑）`,
				subject: goalId,
			});
		}
		seen.add(goalId);
		const goal = goals.find((candidate) => candidate.id === goalId);
		if (!goal) {
			issues.push({
				check: "dangling_queue_entry",
				severity: "error",
				message: `执行队列引用不存在的目标 ${goalId}（sync 或清理 state/queue/ 条目文件）`,
				subject: goalId,
			});
		} else if (goal.status !== "ready") {
			issues.push({
				check: "stale_queue_entry",
				severity: "warning",
				message: `执行队列中的目标 ${goalId} 状态为 ${goal.status}，不再是 ready`,
				subject: goalId,
			});
		}
	}

	// ── interfaces: hash drift and dangling subscribers ──
	for (const entry of interfaces) {
		const report = await bb.interfaces.checkDrift(entry.key);
		if (report.missing) {
			issues.push({
				check: "missing_interface_file",
				severity: "error",
				message: `接口 ${entry.key} 的契约文件 ${entry.canonicalPath} 不存在`,
				subject: entry.key,
			});
		} else if (report.drifted) {
			issues.push({
				check: "interface_drift",
				severity: "warning",
				message: `接口 ${entry.key} 的内容与注册 hash 不一致（sync 将重锚定并可能触发下游 stale）`,
				subject: entry.key,
			});
		}
		for (const subscriber of entry.subscribers) {
			if (!workspots.some((ws) => ws.id === subscriber.workspot)) {
				issues.push({
					check: "dangling_subscriber",
					severity: "warning",
					message: `接口 ${entry.key} 的订阅者工位 ${subscriber.workspot} 不存在`,
					subject: entry.key,
				});
			}
		}
	}

	// ── draft checkpoints without a verification strategy ──
	for (const checkpoint of staging) {
		if (checkpoint.lifecycle === "draft" && !checkpoint.verification) {
			issues.push({
				check: "draft_without_verification",
				severity: "warning",
				message: `checkpoint ${checkpoint.id} 没有 verification 策略，将永远停留在 draft`,
				subject: checkpoint.id,
			});
		}
	}

	// ── config sanity: auto policy needs a positive concurrency cap ──
	const config = await bb.config.load();
	if (config.scheduler.policy === "auto") {
		const cap = config.scheduler.autoConstraints?.maxConcurrentWorkspots;
		if (cap === undefined || cap < 1) {
			issues.push({
				check: "auto_without_cap",
				severity: "error",
				message:
					"scheduler.policy=auto 需要配置 scheduler.autoConstraints.maxConcurrentWorkspots ≥ 1",
			});
		}
	}

	return { ok: issues.every((issue) => issue.severity !== "error"), issues };
}
