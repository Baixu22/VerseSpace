import { useState } from "react";
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
	onAgent,
	busy,
}: {
	workspot: Workspot;
	state: UiState;
	onReview: (cpId: string, approve: boolean) => void;
	onAgent: (workspotId: string, prompt: string) => void;
	busy: boolean;
}) {
	const [prompt, setPrompt] = useState("");
	const agentView = state.agentSessions[workspot.id] ?? null;
	const agentSession = agentView?.session ?? null;
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

			{agentSession && agentView ? (
				<div className="mt-3 border-t border-border-subtle pt-2">
					<div className="flex items-center gap-2">
						<span className="text-mini font-semibold tracking-widest text-fg-muted uppercase">
							agent
						</span>
						<StateBadge
							tone={{
								running: "bg-status-info/15 text-status-info",
								done: "bg-status-success/15 text-status-success",
								failed: "bg-status-danger/15 text-status-danger",
							}}
							value={agentSession.status}
						/>
						{agentSession.exitCode !== undefined &&
						agentSession.exitCode !== null ? (
							<span className="font-mono text-micro text-fg-subtle">
								exit {agentSession.exitCode}
							</span>
						) : null}
					</div>
					{agentView.lastLines.length > 0 ? (
						<div className="mt-1 rounded-md border border-border-subtle bg-bg-base p-2">
							{agentView.lastLines.map((line, index) => (
								<div
									key={`${index}`}
									className="truncate text-small text-fg-muted"
								>
									{line}
								</div>
							))}
						</div>
					) : null}
				</div>
			) : null}

			{agentSession?.status !== "running" ? (
				<form
					className="mt-3 flex gap-2 border-t border-border-subtle pt-3"
					onSubmit={(event) => {
						event.preventDefault();
						const text = prompt.trim();
						if (!text) {
							return;
						}
						onAgent(workspot.id, text);
						setPrompt("");
					}}
				>
					<input
						value={prompt}
						onChange={(event) => setPrompt(event.target.value)}
						placeholder="给这条跑道的 agent 下任务…"
						className="h-8 min-w-0 flex-1 rounded-lg border border-input bg-input/30 px-2.5 text-small outline-none focus-visible:border-ring"
					/>
					<Button type="submit" size="sm" disabled={busy || !prompt.trim()}>
						启动
					</Button>
				</form>
			) : (
				<div className="mt-3 border-t border-border-subtle pt-3 text-small text-fg-muted">
					agent 运行中…
				</div>
			)}

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
