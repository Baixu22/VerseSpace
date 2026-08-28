import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
	type DoctorIssue,
	dispatchGoal,
	fetchState,
	reviewCheckpoint,
	runAgent,
	triggerSync,
	type UiState,
} from "./api";
import { LaneCard } from "./components/lanes";
import { Empty, GoalTree, Metric, Panel, ZoneList } from "./components/panels";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { cn } from "./lib/utils";

function issueTone(severity: DoctorIssue["severity"]) {
	return severity === "error" ? "text-status-danger" : "text-status-warning";
}

interface Verdict {
	key: string;
	kind: string;
	title: string;
	detail: string;
	tone: "err" | "warn";
	actions?: React.ReactNode;
}

/**
 * UI 定律一（裁决优先）：首屏第一公民是"需要人拍板的事"。
 * 没有待裁决项时整个区块塌缩为一行空态——观察税降到零。
 */
function ReviewQueue({
	state,
	onReview,
	busy,
}: {
	state: UiState;
	onReview: (cpId: string, approve: boolean) => void;
	busy: boolean;
}) {
	const items: Verdict[] = [];
	for (const cp of state.checkpoints.staging) {
		if (cp.lifecycle === "awaiting_review") {
			items.push({
				key: `review-${cp.id}`,
				kind: "人工审查",
				title: cp.assertion,
				detail: `${cp.id} · 工位 ${cp.workspot}`,
				tone: "warn",
				actions: (
					<span className="flex gap-1">
						<Button
							size="xs"
							variant="outline"
							disabled={busy}
							onClick={() => onReview(cp.id, true)}
						>
							通过
						</Button>
						<Button
							size="xs"
							variant="destructive"
							disabled={busy}
							onClick={() => onReview(cp.id, false)}
						>
							驳回
						</Button>
					</span>
				),
			});
		}
	}
	for (const cp of state.checkpoints.failed) {
		if (cp.lifecycle === "failed") {
			const tail = cp.verificationResult?.output
				?.split("\n")
				.filter(Boolean)
				.at(-1);
			items.push({
				key: `failed-${cp.id}`,
				kind: "验证失败",
				title: cp.assertion,
				detail: `${cp.id} · 工位 ${cp.workspot}${tail ? ` · ${tail.slice(0, 80)}` : ""}`,
				tone: "err",
			});
		}
	}
	for (const issue of state.doctor.issues) {
		if (issue.severity !== "error") {
			continue;
		}
		items.push({
			key: `doctor-${issue.check}-${issue.subject ?? issue.message}`,
			kind: "一致性错误",
			title: issue.check,
			detail: issue.message,
			tone: "err",
		});
	}
	for (const issue of state.doctor.issues) {
		if (
			issue.check !== "interface_drift" &&
			issue.check !== "active_on_dead_task"
		) {
			continue;
		}
		items.push({
			key: `warn-${issue.check}-${issue.subject ?? issue.message}`,
			kind: "漂移/阻塞",
			title: issue.check,
			detail: issue.message,
			tone: "warn",
		});
	}

	if (items.length === 0) {
		const running = state.workspots.filter(
			(ws) => ws.status === "active",
		).length;
		return (
			<section className="rounded-xl border border-status-success/30 bg-status-success/5 px-4 py-3">
				<p className="text-body text-status-success">
					无需裁决 — {running} 条跑道运行中 ·{" "}
					{state.goals.filter((goal) => goal.status === "ready").length}{" "}
					个目标就绪 · Sync 后此处只出现例外
				</p>
			</section>
		);
	}
	return (
		<section className="rounded-xl border border-status-warning/40 bg-status-warning/5 px-4 py-3">
			<h2 className="text-mini font-semibold tracking-widest text-status-warning uppercase">
				待裁决 · {items.length}
			</h2>
			<div className="mt-2">
				{items.map((item) => (
					<div
						key={item.key}
						className="flex flex-wrap items-center gap-2 border-b border-border-subtle py-2 last:border-b-0"
					>
						<Badge
							variant="outline"
							className={cn(
								"border-transparent",
								item.tone === "err"
									? "bg-status-danger/15 text-status-danger"
									: "bg-status-warning/15 text-status-warning",
							)}
						>
							{item.kind}
						</Badge>
						<span className="font-body">{item.title}</span>
						<span className="truncate font-mono text-micro text-fg-subtle">
							{item.detail}
						</span>
						<span className="ml-auto">{item.actions}</span>
					</div>
				))}
			</div>
		</section>
	);
}

function Dashboard({
	state,
	onDispatch,
	onReview,
	onAgent,
	dispatchNote,
	busy,
}: {
	state: UiState;
	onDispatch: (goalId: string) => void;
	onReview: (cpId: string, approve: boolean) => void;
	onAgent: (workspotId: string, prompt: string) => void;
	dispatchNote: string | null;
	busy: boolean;
}) {
	const counts: Record<string, number> = {};
	for (const goal of state.goals) {
		counts[goal.status] = (counts[goal.status] ?? 0) + 1;
	}
	const drifted = new Set(
		state.doctor.issues
			.filter(
				(issue) =>
					issue.check === "interface_drift" ||
					issue.check === "missing_interface_file",
			)
			.map((issue) => issue.subject),
	);
	const hasIdle = state.workspots.some((ws) => ws.status === "idle");

	return (
		<main className="mx-auto max-w-7xl px-5 pb-14">
			<div className="mt-4">
				<ReviewQueue state={state} onReview={onReview} busy={busy} />
			</div>
			<div className="mt-4 grid grid-cols-3 gap-2.5 sm:grid-cols-5 lg:grid-cols-9">
				<Metric n={state.goals.length} t="目标" />
				<Metric n={counts.ready ?? 0} t="就绪" />
				<Metric n={counts.in_progress ?? 0} t="施工中" />
				<Metric n={counts.done ?? 0} t="完成" />
				<Metric n={state.checkpoints.staging.length} t="staging" />
				<Metric n={state.checkpoints.verified.length} t="verified" />
				<Metric n={state.checkpoints.failed.length} t="failed" />
				<Metric n={state.workspots.length} t="工位" />
				<Metric n={state.queue.length} t="队列" />
			</div>

			{/* Tower: goals/queue on the left rail, workspot lanes on the right */}
			<div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[340px_1fr]">
				<div className="space-y-4">
					<Panel title="工位跑道">
						{state.workspots.length === 0 ? (
							<Empty text="没有工位——用 workbench ws create 创建" />
						) : (
							<div className="space-y-3">
								{state.workspots.map((ws) => (
									<LaneCard
										key={ws.id}
										workspot={ws}
										state={state}
										onReview={onReview}
										onAgent={onAgent}
										busy={busy}
									/>
								))}
							</div>
						)}
					</Panel>
				</div>

				<div className="space-y-4">
					<Panel title="目标 DAG（就绪目标可在此派发到空闲工位）">
						{dispatchNote ? (
							<p className="mb-2 text-small text-status-info">{dispatchNote}</p>
						) : null}
						<GoalTree
							goals={state.goals}
							renderAction={(goal) =>
								goal.status === "ready" ? (
									<Button
										size="xs"
										disabled={busy || !hasIdle}
										title={
											hasIdle
												? `派发 ${goal.id} 到第一个空闲工位`
												: "没有空闲工位"
										}
										onClick={() => onDispatch(goal.id)}
									>
										派发
									</Button>
								) : null
							}
						/>
					</Panel>

					<div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
						<Panel title="执行队列">
							{state.queue.length === 0 ? (
								<Empty text="队列为空" />
							) : (
								state.queue.map((id) => (
									<div
										key={id}
										className="py-1 font-mono text-small text-fg-muted"
									>
										{id}
									</div>
								))
							)}
						</Panel>
						<Panel title="接口注册表">
							{state.interfaces.length === 0 ? (
								<Empty text="没有注册接口" />
							) : (
								state.interfaces.map((entry) => (
									<div
										key={entry.key}
										className="flex flex-wrap items-center gap-2 border-b border-border-subtle py-1.5 last:border-b-0"
									>
										<span className="font-body">{entry.key}</span>
										<Badge_v2>v{entry.version}</Badge_v2>
										{drifted.has(entry.key) ? (
											<span className="text-small font-semibold text-status-danger">
												已漂移
											</span>
										) : null}
										<span className="truncate font-mono text-small text-fg-subtle">
											{entry.canonicalPath}
										</span>
									</div>
								))
							)}
						</Panel>
					</div>

					<Panel title="Checkpoints">
						<div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
							<ZoneList
								title="staging"
								checkpoints={state.checkpoints.staging}
								renderAction={(cp) =>
									cp.lifecycle === "awaiting_review" ? (
										<span className="flex gap-1">
											<Button
												size="xs"
												variant="outline"
												disabled={busy}
												onClick={() => onReview(cp.id, true)}
											>
												通过
											</Button>
											<Button
												size="xs"
												variant="destructive"
												disabled={busy}
												onClick={() => onReview(cp.id, false)}
											>
												驳回
											</Button>
										</span>
									) : null
								}
							/>
							<ZoneList
								title="verified"
								checkpoints={state.checkpoints.verified}
							/>
							<ZoneList title="failed" checkpoints={state.checkpoints.failed} />
						</div>
					</Panel>

					<div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
						<Panel title="事件流（最近 200 条）">
							{state.events.length === 0 ? (
								<Empty text="暂无事件" />
							) : (
								state.events.slice(0, 30).map((event, index) => (
									<div
										key={`${event.timestamp}-${index}`}
										className="border-b border-border-subtle py-1 font-mono text-small last:border-b-0"
									>
										<span className="mr-2 text-fg-subtle">
											{event.timestamp.replace("T", " ").slice(5, 19)}
										</span>
										{event.source}/{event.type}
									</div>
								))
							)}
						</Panel>
						<Panel title="Doctor 体检">
							{state.doctor.issues.length === 0 ? (
								<p className="text-small text-status-success">一切正常 ✓</p>
							) : (
								state.doctor.issues.map((issue, index) => (
									<div
										key={`${issue.check}-${index}`}
										className={cn("py-1 text-small", issueTone(issue.severity))}
									>
										[{issue.severity}] {issue.check} — {issue.message}
									</div>
								))
							)}
						</Panel>
					</div>

					<Panel title="架构决策">
						{state.decisions.length === 0 ? (
							<Empty text="没有决策记录" />
						) : (
							state.decisions.map((d) => (
								<div
									key={d.id}
									className="border-b border-border-subtle py-1.5 last:border-b-0"
								>
									<div className="flex items-center gap-2">
										<span className="font-body">{d.title}</span>
										<span className="font-mono text-small text-fg-subtle">
											{d.author}
										</span>
									</div>
									<p className="text-small text-fg-muted">{d.rationale}</p>
								</div>
							))
						)}
					</Panel>
				</div>
			</div>
		</main>
	);
}

function Badge_v2({ children }: { children: React.ReactNode }) {
	return (
		<span className="inline-flex h-5 items-center rounded-4xl border border-transparent bg-secondary px-2 py-0.5 text-small font-medium text-secondary-foreground">
			{children}
		</span>
	);
}

export default function App() {
	const queryClient = useQueryClient();
	const [syncNote, setSyncNote] = useState<string | null>(null);
	const [dispatchNote, setDispatchNote] = useState<string | null>(null);
	const stateQuery = useQuery({
		queryKey: ["state"],
		queryFn: fetchState,
		refetchInterval: 2000,
	});

	const invalidate = () =>
		queryClient.invalidateQueries({ queryKey: ["state"] });

	const syncMutation = useMutation({
		mutationFn: triggerSync,
		onSuccess: (result) => {
			setSyncNote(`应用 ${result.applied} 个转移`);
			setTimeout(() => setSyncNote(null), 1500);
			invalidate();
		},
		onError: () => setSyncNote("sync 失败"),
	});

	const dispatchMutation = useMutation({
		mutationFn: ({ goalId }: { goalId: string }) => dispatchGoal(goalId),
		onSuccess: (outcome) => {
			setDispatchNote(
				outcome.ok
					? `已派发 → ${outcome.workspotId}（${outcome.worktree}）`
					: `派发失败：${outcome.reason}`,
			);
			setTimeout(() => setDispatchNote(null), 4000);
			invalidate();
		},
	});

	const reviewMutation = useMutation({
		mutationFn: ({ cpId, approve }: { cpId: string; approve: boolean }) =>
			reviewCheckpoint(cpId, approve),
		onSuccess: () => invalidate(),
	});

	const agentMutation = useMutation({
		mutationFn: ({
			workspotId,
			prompt,
		}: {
			workspotId: string;
			prompt: string;
		}) => runAgent(workspotId, prompt),
		onSuccess: () => invalidate(),
	});

	const busy =
		syncMutation.isPending ||
		dispatchMutation.isPending ||
		reviewMutation.isPending ||
		agentMutation.isPending;

	return (
		<div className="min-h-dvh">
			<header className="sticky top-0 z-10 flex items-center gap-3 border-b border-border bg-bg-surface px-5 py-3">
				<h1 className="text-title font-semibold tracking-wide">Workbench</h1>
				<span className="font-mono text-small text-fg-muted">
					{stateQuery.data?.project ?? ""}
				</span>
				{stateQuery.data ? (
					<span
						className={cn(
							"inline-flex h-5 items-center rounded-4xl border border-transparent px-2 text-small font-medium",
							stateQuery.data.doctor.ok
								? "bg-status-success/15 text-status-success"
								: "bg-status-danger/15 text-status-danger",
						)}
					>
						doctor {stateQuery.data.doctor.ok ? "✓" : "✗"}
					</span>
				) : null}
				<span className="text-small text-fg-subtle">{syncNote}</span>
				<Button
					className="ml-auto"
					disabled={busy}
					onClick={() => syncMutation.mutate()}
				>
					{syncMutation.isPending ? "运行中…" : "运行一轮 Sync"}
				</Button>
			</header>
			{stateQuery.data ? (
				<Dashboard
					state={stateQuery.data}
					onDispatch={(goalId) => dispatchMutation.mutate({ goalId })}
					onReview={(cpId, approve) => reviewMutation.mutate({ cpId, approve })}
					onAgent={(workspotId, prompt) =>
						agentMutation.mutate({ workspotId, prompt })
					}
					dispatchNote={dispatchNote}
					busy={busy}
				/>
			) : stateQuery.isError ? (
				<main className="mx-auto max-w-6xl px-5 pt-10 text-status-danger">
					无法连接 workbench ui 后端：{String(stateQuery.error)}
				</main>
			) : (
				<main className="mx-auto max-w-6xl px-5 pt-10 text-fg-muted">
					加载中…
				</main>
			)}
			<footer className="pb-6 text-center text-small text-fg-subtle">
				Workbench v{stateQuery.data?.version ?? ""} · 数据只读自 .workbench/ ·
				每 2 秒自动刷新
			</footer>
		</div>
	);
}
