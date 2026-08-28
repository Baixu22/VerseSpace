import type { Checkpoint, UiState, WbEvent, Workspot } from "../api";
import { Empty, EventLine, StateBadge, WS_TONE } from "./panels";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

/**
 * A workspot lane: the unit of concurrency on the tower. One card per
 * workspot — status, current task, its checkpoints (reviewable inline), and
 * its recent activity feed. Agents' conversations will stream into these
 * lanes once the agent-session layer lands.
 */
export function LaneCard({
	workspot,
	state,
	onReview,
	busy,
}: {
	workspot: Workspot;
	state: UiState;
	onReview: (cpId: string, approve: boolean) => void;
	busy: boolean;
}) {
	const taskId = workspot.currentTask ?? workspot.primaryTask;
	const task = state.goals.find((goal) => goal.id === taskId);
	const laneCps: Checkpoint[] = state.checkpointsByWorkspot[workspot.id] ?? [];
	const laneEvents: WbEvent[] = (state.activity[workspot.id] ?? []).slice(0, 6);

	return (
		<div
			className={
				"rounded-xl border bg-bg-surface p-4 " +
				(workspot.status === "active"
					? "border-status-success/40"
					: workspot.status === "blocked"
						? "border-status-danger/40"
						: "border-border")
			}
		>
			<div className="flex items-center gap-2">
				<span className="text-title font-semibold">{workspot.id}</span>
				<StateBadge tone={WS_TONE} value={workspot.status} />
				{workspot.binding !== "primary" ? (
					<Badge variant="secondary">{workspot.binding}</Badge>
				) : null}
				<span className="ml-auto font-mono text-micro text-fg-subtle">
					{workspot.branch}
				</span>
			</div>

			<div className="mt-2 text-small">
				<span className="text-fg-muted">任务：</span>
				{task ? (
					<span className="font-body">
						{task.title}{" "}
						<span className="font-mono text-micro text-fg-subtle">
							{task.id}
						</span>
					</span>
				) : (
					<span className="text-status-danger">{taskId}（缺失）</span>
				)}
			</div>
			<div className="font-mono text-micro text-fg-subtle">
				{workspot.worktreePath}
			</div>

			{laneCps.length > 0 ? (
				<div className="mt-3 border-t border-border-subtle pt-2">
					{laneCps.map((cp) => (
						<div key={cp.id} className="flex items-center gap-2 py-0.5">
							<span className="font-mono text-micro text-fg-muted">
								{cp.id}
							</span>
							<span className="truncate text-small">{cp.assertion}</span>
							<span className="ml-auto font-mono text-micro">
								{cp.lifecycle}
							</span>
							{cp.lifecycle === "awaiting_review" ? (
								<span className="flex gap-1">
									<Button
										variant="outline"
										size="xs"
										disabled={busy}
										onClick={() => onReview(cp.id, true)}
									>
										通过
									</Button>
									<Button
										variant="destructive"
										size="xs"
										disabled={busy}
										onClick={() => onReview(cp.id, false)}
									>
										驳回
									</Button>
								</span>
							) : null}
						</div>
					))}
				</div>
			) : null}

			<div className="mt-2 border-t border-border-subtle pt-2">
				{laneEvents.length === 0 ? (
					<Empty text="暂无活动" />
				) : (
					laneEvents.map((event, index) => (
						<EventLine key={`${event.timestamp}-${index}`} event={event} />
					))
				)}
			</div>
		</div>
	);
}
