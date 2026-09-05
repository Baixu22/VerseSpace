import { useState } from "react";
import type {
	ResumeCardFactRow,
	ResumeCardNarrativeRow,
} from "../../chat/store";
import { useChatStore } from "../../chat/store";

const BEAT_LABEL: Record<ResumeCardNarrativeRow["kind"], string> = {
	doing: "\u4f60\u5728\u505a\u4ec0\u4e48",
	decided: "\u4f60\u51b3\u5b9a\u4e86\u4ec0\u4e48",
	next: "\u4e0b\u4e00\u6b65",
};

const FACTS_PREVIEW_COUNT = 3;

function FactRow({ fact }: { fact: ResumeCardFactRow }) {
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
					{open ? "\u6536\u8d77\u8bc1\u636e" : "\u67e5\u770b\u8bc1\u636e"}
				</button>
			</div>
			<div className="mt-0.5 text-fg-subtle">{fact.summary}</div>
			<div className="mt-0.5 break-all text-fg-subtle">
				refs: {fact.refs.join(" \u00b7 ")}
			</div>
			{fact.annotation ? (
				<div className="mt-0.5 text-status-warning">
					{"\u26a0"} {fact.annotation.label}
				</div>
			) : null}
			{open ? (
				<div className="mt-1 space-y-1 text-fg-subtle">
					{fact.diff ? (
						<pre className="max-h-40 overflow-auto rounded bg-bg-base p-1.5 font-mono text-micro">
							{fact.diff}
						</pre>
					) : (
						<div>
							{
								"diff \u672a\u4fdd\u7559\uff1b\u7248\u672c\u8bc1\u636e\u4ecd\u53ef\u6838\u5bf9\u3002"
							}
						</div>
					)}
				</div>
			) : null}
		</li>
	);
}

function NarrativeRow({ row }: { row: ResumeCardNarrativeRow }) {
	return (
		<li className="flex items-start gap-2">
			<span className="shrink-0 rounded bg-muted px-1 text-micro text-fg-subtle">
				{BEAT_LABEL[row.kind]}
			</span>
			<span className="flex-1 text-micro text-fg-muted">
				{row.text}
				{row.annotation ? (
					<span className="ml-1 text-status-warning">
						{"\u26a0"} {row.annotation.label}
					</span>
				) : null}
				<span className="mt-0.5 block break-all text-fg-subtle">
					refs: {row.refs.join(" \u00b7 ")}
				</span>
			</span>
		</li>
	);
}

/** Dual-channel restore card: facts first, narrative second (TF-0128). */
export function ResumeCard() {
	const card = useChatStore((s) => s.resumeCard);
	const note = useChatStore((s) => s.resumeNote);
	const diff = useChatStore((s) => s.readSetDiff);
	const delta = useChatStore((s) => s.resumeDelta);
	const dismissed = useChatStore((s) => s.resumeCardDismissed);
	const revealed = useChatStore((s) => s.resumeCardRevealed);
	const consume = useChatStore((s) => s.consumeResumeNote);
	const dismiss = useChatStore((s) => s.dismissResumeCard);
	const [factsExpanded, setFactsExpanded] = useState(false);
	if (!card) {
		return null;
	}
	if (dismissed && !revealed) {
		return null;
	}
	const facts = card.facts;
	const visibleFacts = factsExpanded
		? facts
		: facts.slice(0, FACTS_PREVIEW_COUNT);
	const hiddenCount = Math.max(0, facts.length - visibleFacts.length);
	return (
		<div className="mx-6 mb-2 rounded-xl border border-border-subtle bg-bg-surface px-3 py-2">
			<div className="flex items-center gap-2">
				<span className="text-micro text-fg-muted">
					{"\u6062\u590d\u5361"}
					{note
						? ` \u00b7 \u79bb\u5f00\u4e8e ${new Date(note.draftedAt).toLocaleString()}`
						: ""}
				</span>
				<span className="flex-1 text-micro text-fg-subtle">
					{note?.confirmedAt
						? "\u00b7 \u5df2\u786e\u8ba4"
						: note
							? "\u00b7 \u5f85\u786e\u8ba4"
							: ""}
					{delta > 0
						? ` \u00b7 \u4f60\u4e0d\u5728\u65f6\u591a\u4e86 ${delta} \u6761`
						: ""}
				</span>
				<button
					type="button"
					onClick={() => void dismiss()}
					className="text-micro text-fg-subtle hover:text-fg-default"
				>
					{"\u6536\u8d77"}
				</button>
				{note && !note.confirmedAt ? (
					<button
						type="button"
						onClick={() => void useChatStore.getState().confirmResumeNote()}
						className="text-micro text-fg-subtle hover:text-status-success"
					>
						{"\u786e\u8ba4"}
					</button>
				) : null}
			</div>
			{facts.length > 0 ? (
				<div className="mt-2">
					<div className="text-micro text-fg-subtle">
						{"\u4e8b\u5b9e"} ({facts.length})
					</div>
					<ul className="mt-1.5 space-y-1.5">
						{visibleFacts.map((fact) => (
							<FactRow
								key={`${fact.source}-${fact.path}-${fact.currentVersion ?? "missing"}`}
								fact={fact}
							/>
						))}
					</ul>
					{hiddenCount > 0 ? (
						<button
							type="button"
							className="mt-1 text-micro text-fg-subtle hover:text-fg-default"
							onClick={() => {
								setFactsExpanded(true);
								void consume("facts");
							}}
						>
							{"\u53ca\u53e6"} {hiddenCount} {"\u6761"}
						</button>
					) : null}
				</div>
			) : null}
			{card.narrative.length > 0 ? (
				<ol className="mt-2 space-y-1.5 border-t border-border-subtle pt-2">
					{delta > 0 ? (
						<li className="text-micro text-fg-subtle">
							{"\u4f60\u4e0d\u5728\u65f6\u8fd9\u6761\u5bf9\u8bdd\u591a\u4e86"}{" "}
							{delta}{" "}
							{
								"\u6761\u2014\u2014\u5f80\u4e0b\u7ffb\u770b\u65b0\u5185\u5bb9\u3002"
							}
						</li>
					) : null}
					{card.narrative.map((row, index) => (
						<NarrativeRow key={`${row.kind}-${index}`} row={row} />
					))}
				</ol>
			) : null}
			{diff ? (
				<div className="mt-2 border-t border-border-subtle pt-2 text-micro text-fg-subtle">
					{"\u524d\u63d0\u76d1\u6d4b\uff1a\u5df2\u6bd4\u5bf9"} {diff.comparable}
					/{diff.compared} {"\u4e2a\u53ef\u6bd4\u524d\u63d0"}
					{diff.unsupported > 0
						? ` \u00b7 ${diff.unsupported} \u4e2a\u8303\u56f4\u672a\u77e1`
						: ""}
					{diff.uncoveredTools.length > 0
						? ` \u00b7 \u672a\u8986\u76d6\u5de5\u5177\uff1a${diff.uncoveredTools.join("\u3001")}`
						: ""}
					{diff.status === "unknown"
						? " \u00b7 \u79bb\u5f00\u57fa\u51c6\u4e0d\u8db3\uff0c\u5f53\u524d\u65e0\u6cd5\u5224\u65ad\u8bfb\u96c6\u53d8\u5316\u3002"
						: ""}
				</div>
			) : null}
		</div>
	);
}
