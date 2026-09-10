import { useEffect, useId, useState } from "react";
import { apiFetch } from "../../auth";
import { useChatStore } from "../../chat/store";
import { Tooltip } from "../ui/tooltip";

interface Evidence {
	kind: string;
	title: string;
	timestamp?: string;
	content: string;
	truncated: boolean;
}

function label(ref: string, index: number): string {
	if (ref.startsWith("message:")) return "消息";
	if (ref.startsWith("tool:")) return "工具调用";
	if (ref.startsWith("path:")) return "文件记录";
	if (ref.startsWith("ledger:")) return "决策记录";
	if (ref.startsWith("legacy:")) return "旧版笔记";
	if (ref === "promotion") return "命名记录";
	return `${ref.startsWith("footprint") ? "足迹" : "事件"} ${index + 1}`;
}

export function EvidenceRefs({ refs }: { refs: string[] }) {
	const threadId = useChatStore((state) => state.activeId);
	const recordAction = useChatStore((state) => state.recordResumeAction);
	const [selected, setSelected] = useState<{
		threadId: string;
		ref: string;
	} | null>(null);
	const [result, setResult] = useState<{ evidence?: Evidence; error?: string }>(
		{},
	);
	const panelId = useId();
	const open =
		selected?.threadId === threadId && refs.includes(selected?.ref ?? "");

	useEffect(() => {
		if (!open || !selected) return;
		const controller = new AbortController();
		setResult({});
		void apiFetch(
			`/api/chat/threads/${encodeURIComponent(selected.threadId)}/evidence?ref=${encodeURIComponent(selected.ref)}`,
			{
				signal: controller.signal,
			},
		)
			.then(async (response) => {
				if (!response.ok) throw new Error(`无法读取来源（${response.status}）`);
				const evidence = (await response.json()) as Evidence;
				if (!controller.signal.aborted) setResult({ evidence });
			})
			.catch((error: unknown) => {
				if (!controller.signal.aborted) setResult({ error: String(error) });
			});
		return () => controller.abort();
	}, [open, selected]);

	if (refs.length === 0) return null;
	return (
		<div className="mt-2 text-small text-fg-muted">
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
				<span>来源：</span>
				{[...new Set(refs)].map((ref, index) => (
					<Tooltip key={ref} content={ref}>
						<button
							type="button"
							disabled={!threadId}
							aria-expanded={open && selected?.ref === ref}
							aria-controls={panelId}
							className="cursor-pointer text-accent-default hover:underline disabled:opacity-50"
							onClick={() => {
								if (!threadId) return;
								if (open && selected?.ref === ref) {
									setSelected(null);
									return;
								}
								setResult({});
								setSelected({ threadId, ref });
								void recordAction("resume_evidence_opened");
							}}
						>
							{label(ref, index)}
						</button>
					</Tooltip>
				))}
			</div>
			{open ? (
				<div
					id={panelId}
					role="region"
					aria-label="证据内容"
					aria-live="polite"
					className="mt-2 rounded-lg border border-border-subtle bg-bg-base p-3"
				>
					{result.error ? (
						<div role="alert">{result.error}</div>
					) : result.evidence ? (
						<>
							<div className="text-fg-muted">{result.evidence.title}</div>
							{result.evidence.timestamp ? (
								<div>
									{new Date(result.evidence.timestamp).toLocaleString()}
								</div>
							) : null}
							<pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-all font-mono text-micro">
								{result.evidence.content}
							</pre>
							{result.evidence.truncated ? (
								<div className="mt-1">
									内容较长，仅展示前 16,000 个字符；原始记录仍保留。
								</div>
							) : null}
						</>
					) : (
						"正在读取来源…"
					)}
				</div>
			) : null}
		</div>
	);
}
