import type { Checkpoint, Goal, WbEvent } from "../api";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";

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

export const WS_TONE: Record<string, string> = {
	idle: "bg-fg-subtle/15 text-fg-subtle",
	active: "bg-status-success/15 text-status-success",
	blocked: "bg-status-danger/15 text-status-danger",
	completed: "bg-status-success/15 text-status-success",
};

export function StateBadge({
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

export function Panel({
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

export function Empty({ text }: { text: string }) {
	return <p className="text-small text-fg-subtle italic">{text}</p>;
}

export function Metric({ n, t }: { n: number; t: string }) {
	return (
		<div className="rounded-lg border border-border bg-bg-elevated px-3 py-2.5">
			<div className="font-mono text-heading font-semibold">{n}</div>
			<div className="text-mini text-fg-muted">{t}</div>
		</div>
	);
}

export function EventLine({ event }: { event: WbEvent }) {
	return (
		<div className="py-0.5 font-mono text-micro text-fg-muted">
			<span className="mr-1.5 text-fg-subtle">
				{event.timestamp.replace("T", " ").slice(11, 19)}
			</span>
			{event.type}
		</div>
	);
}

/** Goal DAG as an indented tree with per-goal slot for actions. */
export function GoalTree({
	goals,
	renderAction,
}: {
	goals: Goal[];
	renderAction?: (goal: Goal) => React.ReactNode;
}) {
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
			<div key={id} className="flex items-center gap-2 py-1">
				<span
					className="font-mono text-micro text-fg-subtle"
					style={{ width: `${depth * 14}px` }}
				>
					{depth > 0 ? "└" : ""}
				</span>
				<span className="truncate font-body">{goal.title}</span>
				<StateBadge tone={GOAL_TONE} value={goal.status} />
				<span className="ml-auto shrink-0">{renderAction?.(goal)}</span>
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

export function ZoneList({
	title,
	checkpoints,
	renderAction,
}: {
	title: string;
	checkpoints: Checkpoint[];
	renderAction?: (cp: Checkpoint) => React.ReactNode;
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
							<span className="ml-auto">{renderAction?.(cp)}</span>
						</div>
						<p className="truncate text-small">{cp.assertion}</p>
					</div>
				))
			)}
		</div>
	);
}
