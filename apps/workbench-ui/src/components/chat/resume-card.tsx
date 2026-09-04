import { useState } from "react";
import type { ReadSetDiffFact, ResumeBeat } from "../../chat/store";
import { useChatStore } from "../../chat/store";

const BEAT_LABEL: Record<ResumeBeat["kind"], string> = {
	doing: "你在做什么",
	decided: "你决定了什么",
	shifted: "脚下什么动了",
	next: "下一步",
};

function FactRow({ fact }: { fact: ReadSetDiffFact }) {
	const [open, setOpen] = useState(false);
	const recordAction = useChatStore((s) => s.recordResumeAction);
	return (
		<li className="rounded border border-border-subtle px-2 py-1.5 text-micro">
			<div className="flex items-start gap-2">
				<span
					className="min-w-0 flex-1 truncate text-fg-muted"
					title={fact.path}
				>
					{fact.path}
				</span>
				<button
					type="button"
					className="shrink-0 text-fg-subtle hover:text-fg-default"
					onClick={() => {
						setOpen((value) => !value);
						void recordAction("resume_fact_opened");
					}}
				>
					{open ? "收起证据" : "查看证据"}
				</button>
			</div>
			<div className="mt-0.5 text-fg-subtle">
				{fact.observedVersion.slice(0, 10)} →{" "}
				{fact.currentVersion?.slice(0, 10) ?? "文件不存在"}
				<span className="ml-2">
					推定写者：{fact.writerLabel || fact.writerId || "未知"}
				</span>
			</div>
			{open ? (
				<div className="mt-1 space-y-1 text-fg-subtle">
					<div>证据：{fact.refs.join("、") || "未知"}</div>
					{fact.diff ? (
						<pre className="max-h-40 overflow-auto rounded bg-bg-base p-1.5 font-mono text-micro">
							{fact.diff}
						</pre>
					) : (
						<div>diff 未保留；版本证据仍可核对。</div>
					)}
				</div>
			) : null}
		</li>
	);
}

/** Additive restore card: narrative reminder first, repository facts second. */
export function ResumeCard() {
	const note = useChatStore((s) => s.resumeNote);
	const diff = useChatStore((s) => s.readSetDiff);
	const delta = useChatStore((s) => s.resumeDelta);
	const dismissed = useChatStore((s) => s.resumeCardDismissed);
	const consume = useChatStore((s) => s.consumeResumeNote);
	const dismiss = useChatStore((s) => s.dismissResumeCard);
	const [expanded, setExpanded] = useState(false);
	const [factsExpanded, setFactsExpanded] = useState(true);
	if (!note || dismissed) {
		return null;
	}
	const facts = diff?.stale ?? [];
	const toggleNarrative = () => {
		setExpanded((value) => {
			if (!value) {
				void consume("card-expanded");
			}
			return !value;
		});
	};
	return (
		<div className="mx-6 mb-2 rounded-xl border border-border-subtle bg-bg-surface px-3 py-2">
			<div className="flex items-center gap-2">
				<button
					type="button"
					onClick={toggleNarrative}
					className="text-micro text-fg-muted hover:text-fg-default"
				>
					{expanded ? "▾" : "▸"} 恢复笔记 · 离开于{" "}
					{new Date(note.draftedAt).toLocaleString()}
				</button>
				<span className="flex-1 text-micro text-fg-subtle">
					{note.confirmedAt ? "· 已确认" : "· 待确认"}
					{delta > 0 ? ` · 你不在时多了 ${delta} 条` : ""}
				</span>
				<button
					type="button"
					onClick={() => void dismiss()}
					className="text-micro text-fg-subtle hover:text-fg-default"
				>
					收起
				</button>
				{!note.confirmedAt ? (
					<button
						type="button"
						onClick={() => void useChatStore.getState().confirmResumeNote()}
						className="text-micro text-fg-subtle hover:text-status-success"
					>
						确认
					</button>
				) : null}
			</div>
			{expanded ? (
				<ol className="mt-1.5 space-y-1.5">
					{delta > 0 ? (
						<li className="text-micro text-fg-subtle">
							你不在时这条对话多了 {delta} 条——往下翻看新内容。
						</li>
					) : null}
					{note.beats.map((beat, index) => (
						<li
							key={`${beat.kind}-${index}`}
							className="flex items-start gap-2"
						>
							<span className="shrink-0 rounded bg-muted px-1 text-micro text-fg-subtle">
								{BEAT_LABEL[beat.kind]}
							</span>
							<span className="flex-1 text-micro text-fg-muted">
								{beat.text}
							</span>
						</li>
					))}
				</ol>
			) : null}
			{diff ? (
				<div className="mt-2 border-t border-border-subtle pt-2">
					<div className="flex items-center gap-2 text-micro text-fg-subtle">
						<span className="flex-1">
							前提监测：已比对 {diff.comparable}/{diff.compared} 个可比前提
							{diff.unsupported > 0 ? ` · ${diff.unsupported} 个范围未知` : ""}
							{diff.uncoveredTools.length > 0
								? ` · 未覆盖工具：${diff.uncoveredTools.join("、")}`
								: ""}
						</span>
						{facts.length > 0 ? (
							<button
								type="button"
								className="hover:text-fg-default"
								onClick={() => {
									setFactsExpanded((value) => !value);
									void consume("facts");
								}}
							>
								{factsExpanded ? "收起事实" : `查看 ${facts.length} 个失效前提`}
							</button>
						) : null}
					</div>
					{diff.status === "unknown" ? (
						<div className="mt-1 text-micro text-fg-subtle">
							离开基准不足，当前无法判断读集变化。
						</div>
					) : null}
					{factsExpanded && facts.length > 0 ? (
						<ul className="mt-1.5 space-y-1.5">
							{facts.map((fact) => (
								<FactRow
									key={`${fact.path}-${fact.currentVersion ?? "missing"}`}
									fact={fact}
								/>
							))}
						</ul>
					) : null}
				</div>
			) : null}
		</div>
	);
}
