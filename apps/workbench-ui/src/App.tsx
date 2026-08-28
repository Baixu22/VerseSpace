import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
	type Checkpoint,
	type DoctorIssue,
	fetchState,
	type Goal,
	type SyncResult,
	triggerSync,
	type UiState,
} from "./api";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Separator } from "./components/ui/separator";
import { cn } from "./lib/utils";

const GOAL_TONE: Record<string, string> = {
	planned: "bg-fg-subtle/15 text-fg-subtle",
	ready: "bg-status-info/15 text-status-info",
	in_progress: "bg-status-warning/15 text-status-warning",
	done: "bg-status-success/15 text-status-success",
	stale_done: "bg-status-danger/15 text-status-danger",
	cancelled: "bg-status-danger/15 text-status-danger",
};

const CP_TONE: Record<string, string> = {
	draft: "bg-fg-subtle/15 text-fg-subtle",
	pending: "bg-status-warning/15 text-status-warning",
	verified: "bg-status-success/15 text-status-success",
	applied: "bg-status-success/15 text-status-success",
	awaiting_review: "bg-status-info/15 text-status-info",
	failed: "bg-status-danger/15 text-status-danger",
	rejected: "bg-status-danger/15 text-status-danger",
};

const WS_TONE: Record<string, string> = {
	idle: "bg-fg-subtle/15 text-fg-subtle",
	active: "bg-status-success/15 text-status-success",
	blocked: "bg-status-danger/15 text-status-danger",
	completed: "bg-status-success/15 text-status-success",
};

function StateBadge({
	tone,
	value,
}: {
	tone: Record<string, string>;
	value: string;
}) {
	return (
		<Badge variant="outline" className={cn("border-transparent", tone[value])}>
			{value}
		</Badge>
	);
}

function Panel({
	title,
	children,
	className,
}: {
	title: string;
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<section
			className={cn(
				"rounded-xl border border-border bg-bg-surface p-4",
				className,
			)}
		>
			<h2 className="text-mini font-semibold tracking-widest text-fg-muted uppercase">
				{title}
			</h2>
			<div className="mt-3">{children}</div>
		</section>
	);
}

function Empty({ text }: { text: string }) {
	return <p className="text-small text-fg-subtle italic">{text}</p>;
}

function GoalTree({ goals }: { goals: Goal[] }) {
	const byId = new Map(goals.map((goal) => [goal.id, goal]));
	const children = new Map<string, string[]>();
	const roots: string[] = [];
	for (const goal of goals) {
		if (goal.dependsOn.length === 0) {
			roots.push(goal.id);
		}
		for (const dep of goal.dependsOn) {
			children.set(dep, [...(children.get(dep) ?? []), goal.id]);
		}
	}
	const lines: React.ReactNode[] = [];
	const seen = new Set<string>();
	const walk = (id: string, depth: number) => {
		const goal = byId.get(id);
		if (!goal) {
			lines.push(
				<div key={`${id}-missing`} className="py-1 text-small text-fg-subtle">
					{"· ".repeat(depth)}
					{id}（缺失）
				</div>,
			);
			return;
		}
		if (seen.has(id)) {
			lines.push(
				<div key={`${id}-cycle`} className="py-1 text-small text-status-danger">
					{"· ".repeat(depth)}↻ {id}
				</div>,
			);
			return;
		}
		seen.add(id);
		lines.push(
			<div key={id} className="flex items-center gap-2 py-1.5">
				<span className="font-body">{goal.title}</span>
				<StateBadge tone={GOAL_TONE} value={goal.status} />
				<span className="font-mono text-small text-fg-subtle">{goal.id}</span>
			</div>,
		);
		for (const child of (children.get(id) ?? []).sort()) {
			walk(child, depth + 1);
		}
	};
	for (const root of roots.sort()) {
		walk(root, 0);
	}
	for (const goal of goals) {
		if (!seen.has(goal.id)) {
			walk(goal.id, 0);
		}
	}
	return <div>{lines.length === 0 ? <Empty text="还没有目标" /> : lines}</div>;
}

function ZoneList({
	title,
	checkpoints,
}: {
	title: string;
	checkpoints: Checkpoint[];
}) {
	return (
		<div className="min-w-0">
			<h3 className="mb-2 font-mono text-small text-fg-muted">
				{title} · {checkpoints.length}
			</h3>
			{checkpoints.length === 0 ? (
				<Empty text="空" />
			) : (
				checkpoints.map((cp) => (
					<div
						key={cp.id}
						className="border-b border-border-subtle py-1.5 last:border-b-0"
					>
						<div className="flex items-center gap-2">
							<span className="font-mono text-small text-fg-muted">
								{cp.id}
							</span>
							<StateBadge tone={CP_TONE} value={cp.lifecycle} />
						</div>
						<p className="truncate text-small">{cp.assertion}</p>
					</div>
				))
			)}
		</div>
	);
}

function Card({ n, t }: { n: number; t: string }) {
	return (
		<div className="rounded-lg border border-border bg-bg-elevated px-3 py-2.5">
			<div className="font-mono text-heading font-semibold">{n}</div>
			<div className="text-mini text-fg-muted">{t}</div>
		</div>
	);
}

function issueTone(severity: DoctorIssue["severity"]) {
	return severity === "error" ? "text-status-danger" : "text-status-warning";
}

function Dashboard({ state }: { state: UiState }) {
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

	return (
		<main className="mx-auto max-w-6xl px-5 pb-14">
			<div className="mt-4 grid grid-cols-3 gap-2.5 sm:grid-cols-5 lg:grid-cols-9">
				<Card n={state.goals.length} t="目标" />
				<Card n={counts.ready ?? 0} t="就绪" />
				<Card n={counts.in_progress ?? 0} t="施工中" />
				<Card n={counts.done ?? 0} t="完成" />
				<Card n={state.checkpoints.staging.length} t="staging" />
				<Card n={state.checkpoints.verified.length} t="verified" />
				<Card n={state.checkpoints.failed.length} t="failed" />
				<Card n={state.workspots.length} t="工位" />
				<Card n={state.queue.length} t="队列" />
			</div>

			<Panel title="目标 DAG" className="mt-4">
				<GoalTree goals={state.goals} />
			</Panel>

			<div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
				<Panel title="工位">
					{state.workspots.length === 0 ? (
						<Empty text="没有工位" />
					) : (
						state.workspots.map((ws) => (
							<div
								key={ws.id}
								className="flex flex-wrap items-center gap-2 border-b border-border-subtle py-1.5 last:border-b-0"
							>
								<span className="font-body">{ws.id}</span>
								<StateBadge tone={WS_TONE} value={ws.status} />
								<Badge variant="secondary">{ws.binding}</Badge>
								<span className="font-mono text-small text-fg-subtle">
									{ws.currentTask ?? ws.primaryTask} · {ws.branch}
								</span>
							</div>
						))
					)}
				</Panel>
				<Panel title="执行队列">
					{state.queue.length === 0 ? (
						<Empty text="队列为空" />
					) : (
						state.queue.map((id) => (
							<div
								key={id}
								className="py-1.5 font-mono text-small text-fg-muted"
							>
								{id}
							</div>
						))
					)}
				</Panel>
			</div>

			<Panel title="Checkpoints" className="mt-4">
				<div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
					<ZoneList title="staging" checkpoints={state.checkpoints.staging} />
					<ZoneList title="verified" checkpoints={state.checkpoints.verified} />
					<ZoneList title="failed" checkpoints={state.checkpoints.failed} />
				</div>
			</Panel>

			<div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
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
								<Badge variant="secondary">v{entry.version}</Badge>
								{drifted.has(entry.key) ? (
									<Badge className="bg-status-danger/15 text-status-danger">
										已漂移
									</Badge>
								) : null}
								<span className="font-mono text-small text-fg-subtle">
									{entry.canonicalPath}
								</span>
							</div>
						))
					)}
				</Panel>
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

			<div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
				<Panel title="事件流（最近 50 条）">
					{state.events.length === 0 ? (
						<Empty text="暂无事件" />
					) : (
						state.events.map((event, index) => (
							<div
								// eslint-disable-next-line react/no-array-index-key -- log rows carry no stable id
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
								// eslint-disable-next-line react/no-array-index-key -- report rows are positional
								key={`${issue.check}-${index}`}
								className={cn("py-1 text-small", issueTone(issue.severity))}
							>
								[{issue.severity}] {issue.check} — {issue.message}
							</div>
						))
					)}
				</Panel>
			</div>
		</main>
	);
}

export default function App() {
	const queryClient = useQueryClient();
	const [syncNote, setSyncNote] = useState<string | null>(null);
	const stateQuery = useQuery({
		queryKey: ["state"],
		queryFn: fetchState,
		refetchInterval: 2000,
	});
	const syncMutation = useMutation({
		mutationFn: triggerSync,
		onSuccess: (result: SyncResult) => {
			setSyncNote(`应用 ${result.applied} 个转移`);
			setTimeout(() => setSyncNote(null), 1500);
			queryClient.invalidateQueries({ queryKey: ["state"] });
		},
		onError: () => setSyncNote("sync 失败"),
	});

	return (
		<div className="min-h-dvh">
			<header className="sticky top-0 z-10 flex items-center gap-3 border-b border-border bg-bg-surface px-5 py-3">
				<h1 className="text-title font-semibold tracking-wide">Workbench</h1>
				<span className="font-mono text-small text-fg-muted">
					{stateQuery.data?.project ?? ""}
				</span>
				{stateQuery.data ? (
					<Badge
						variant="outline"
						className={cn(
							"border-transparent",
							stateQuery.data.doctor.ok
								? "bg-status-success/15 text-status-success"
								: "bg-status-danger/15 text-status-danger",
						)}
					>
						doctor {stateQuery.data.doctor.ok ? "✓" : "✗"}
					</Badge>
				) : null}
				<span className="text-small text-fg-subtle">{syncNote}</span>
				<Button
					className="ml-auto"
					disabled={syncMutation.isPending}
					onClick={() => syncMutation.mutate()}
				>
					{syncMutation.isPending ? "运行中…" : "运行一轮 Sync"}
				</Button>
			</header>
			{stateQuery.data ? (
				<Dashboard state={stateQuery.data} />
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
			<Separator className="hidden" />
		</div>
	);
}
