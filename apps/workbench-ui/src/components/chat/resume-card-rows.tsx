import { motion } from "motion/react";
import { useState } from "react";
import { ChevronRight, GitBranch } from "@/components/icon";
import type {
	ResumeCardFactRow,
	ResumeCardNarrativeRow,
} from "../../chat/store";
import { useChatStore } from "../../chat/store";
import { STAGGER_CHILD, TWEEN_DISCLOSURE, TWEEN_FAST } from "../../lib/motion";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Tooltip } from "../ui/tooltip";
import { AnimatedDisclosure } from "./animated-disclosure";
import { EvidenceRefs } from "./evidence-refs";

const BEAT_LABEL: Record<ResumeCardNarrativeRow["kind"], string> = {
	doing: "你在做什么",
	decided: "你决定了什么",
	next: "下一步",
};

export function ResumeFactRow({ fact }: { fact: ResumeCardFactRow }) {
	const [open, setOpen] = useState(false);
	const recordAction = useChatStore((s) => s.recordResumeAction);
	const switchThread = useChatStore((s) => s.switchThread);
	return (
		<motion.li
			variants={STAGGER_CHILD}
			transition={TWEEN_DISCLOSURE}
			className="rounded-lg border border-border-subtle bg-bg-base/70 text-small"
		>
			<div className="flex items-start gap-2 px-2.5 py-2">
				<Tooltip content={fact.path}>
					<button
						type="button"
						aria-expanded={open}
						className="flex min-w-0 flex-1 cursor-pointer items-start gap-2 text-left"
						onClick={() => {
							setOpen((value) => !value);
							if (!open) void recordAction("resume_fact_opened");
						}}
					>
						<motion.span
							animate={{ rotate: open ? 90 : 0 }}
							transition={TWEEN_FAST}
							className="mt-0.5 shrink-0 text-fg-subtle"
						>
							<ChevronRight className="size-3.5" />
						</motion.span>
						<span className="min-w-0">
							<span className="block truncate font-medium text-fg-muted">
								{fact.path}
							</span>
							<span className="mt-0.5 block text-fg-subtle">
								{fact.summary}
							</span>
						</span>
					</button>
				</Tooltip>
				{fact.branch ? (
					<Button
						type="button"
						variant="ghost"
						size="xs"
						className="shrink-0 text-accent-default"
						onClick={async () => {
							await recordAction("resume_branch_opened");
							await switchThread(fact.branch!.threadId);
						}}
					>
						<GitBranch className="size-3" />
						查看分支
						<motion.span className="inline-flex" transition={TWEEN_FAST}>
							<ChevronRight className="size-3" />
						</motion.span>
					</Button>
				) : null}
			</div>
			{fact.annotation ? (
				<div className="mx-2.5 mb-2 rounded-md bg-status-warning/10 px-2 py-1 text-status-warning">
					{fact.annotation.label}
				</div>
			) : null}
			<AnimatedDisclosure open={open}>
				<div className="border-t border-border-subtle px-3 py-2 text-fg-subtle">
					{fact.branch ? (
						<ul className="max-h-40 space-y-1 overflow-auto">
							{fact.branch.paths.map((path) => (
								<li key={path} className="font-mono">
									{path}
								</li>
							))}
						</ul>
					) : fact.diff ? (
						<pre className="max-h-40 overflow-auto rounded-md bg-bg-surface p-2 font-mono text-small">
							{fact.diff}
						</pre>
					) : (
						<div>diff 未保留；版本证据仍可核对。</div>
					)}
					<EvidenceRefs refs={fact.refs} />
				</div>
			</AnimatedDisclosure>
		</motion.li>
	);
}

export function ResumeNarrativeRow({ row }: { row: ResumeCardNarrativeRow }) {
	return (
		<motion.li variants={STAGGER_CHILD} className="relative pl-5">
			<span
				aria-hidden
				className={cn(
					"absolute left-0 top-1.5 size-2 rounded-full ring-4 ring-bg-surface",
					row.kind === "next" ? "bg-accent-default" : "bg-fg-subtle",
				)}
			/>
			<div className="flex flex-wrap items-baseline gap-x-2">
				<span className="text-small font-medium text-fg-muted">
					{BEAT_LABEL[row.kind]}
				</span>
				{row.annotation ? (
					<span className="text-small text-status-warning">
						{row.annotation.label}
					</span>
				) : null}
			</div>
			<div className="mt-0.5 text-small leading-relaxed text-fg-muted">
				{row.text}
				<EvidenceRefs refs={row.refs} />
			</div>
		</motion.li>
	);
}
