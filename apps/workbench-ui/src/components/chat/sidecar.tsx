import { unstable_useComposerInput } from "@assistant-ui/react";
import { useEffect, useRef, useState } from "react";
import { useChatStore } from "../../chat/store";
import { ResumeCard } from "./resume-card";

/**
 * composer 上方的安静层（TF-0095/0096）：决策账本、停放快照、系统提议
 * 的下一步。全部默认收起/为空即不渲染——不占据阅读流，只待在余光里。
 *
 * DraftMirror 把 composer 文本镜像进 store（TF-0096 草稿停放的数据源），
 * 并在切换线程的瞬间把上一个线程的草稿收进停放快照、清空 composer。
 */
function DraftMirror() {
	const activeId = useChatStore((s) => s.activeId);
	const composer = unstable_useComposerInput();
	const seen = useRef({ id: activeId, value: composer.value });
	useEffect(() => {
		const prev = seen.current;
		if (prev.id && prev.id !== activeId) {
			// switchThread normally parks the draft synchronously. The guard keeps
			// this effect safe when React observes the lane change before the store
			// mirror has flushed, without creating a duplicate parked item.
			const state = useChatStore.getState();
			const alreadyParked = (state.parked[prev.id] ?? []).some(
				(item) => item.text === prev.value.trim(),
			);
			if (prev.value.trim() && !alreadyParked) {
				state.parkDraft(prev.id, prev.value);
			}
			if (composer.value) {
				composer.setText("");
			}
			seen.current = { id: activeId, value: "" };
			return;
		}
		seen.current = { id: activeId, value: composer.value };
		if (activeId) {
			useChatStore.getState().setDraft(activeId, composer.value);
		}
	}, [activeId, composer.value]);
	return null;
}

/** 决策账本（TF-0095）：自动填充、默认折叠、无分歧时完全不渲染。 */
function DecisionLedger() {
	const points = useChatStore((s) => s.decisionPoints);
	const [expanded, setExpanded] = useState(false);
	if (points.length === 0) {
		return null;
	}
	return (
		<div className="mx-6 mb-2 rounded-xl border border-border-subtle bg-bg-base px-3 py-2">
			<button
				type="button"
				onClick={() => setExpanded(!expanded)}
				className="flex w-full items-center gap-2 text-left"
			>
				<span className="text-micro text-fg-subtle">
					{expanded ? "▾" : "▸"} 决策账本 · {points.length} 个分歧点
				</span>
			</button>
			{expanded ? (
				<ul className="mt-1.5 space-y-1">
					{points.map((point) => (
						<li
							key={`${point.kind}-${point.messageId}`}
							className="flex items-center gap-2 text-micro text-fg-muted"
						>
							<span className="shrink-0 rounded bg-muted px-1 text-fg-subtle">
								{point.kind === "fork"
									? `分叉 ×${point.count}`
									: `备选 ×${point.count}`}
							</span>
							<span className="flex-1 truncate">{point.preview}</span>
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
}

/** 停放快照（TF-0096）：返回车道时以可筛选列表呈现，允许丢掉过时的。 */
function ParkedBar() {
	const activeId = useChatStore((s) => s.activeId);
	const items = useChatStore((s) =>
		s.activeId ? s.parked[s.activeId] : undefined,
	);
	const composer = unstable_useComposerInput();
	const [filter, setFilter] = useState("");
	const [expanded, setExpanded] = useState(false);
	if (!activeId || !items || items.length === 0) {
		return null;
	}
	const visible = filter
		? items.filter((item) => item.text.includes(filter))
		: items;
	return (
		<div className="mx-6 mb-2 rounded-xl border border-border-subtle bg-bg-surface px-3 py-2">
			<div className="flex items-center gap-2">
				<button
					type="button"
					onClick={() => setExpanded(!expanded)}
					className="text-micro text-fg-muted hover:text-fg-default"
				>
					{expanded ? "▾" : "▸"} 停放快照 · {items.length} 项
				</button>
				<span className="flex-1 text-micro text-fg-subtle">
					切换离开时自动收起
				</span>
				<button
					type="button"
					title="丢弃全部停放项"
					onClick={() => useChatStore.getState().clearParked(activeId)}
					className="text-micro text-fg-subtle hover:text-status-danger"
				>
					全部丢弃
				</button>
			</div>
			{expanded ? (
				<div className="mt-1.5 space-y-1.5">
					{items.length > 1 ? (
						<input
							value={filter}
							onChange={(event) => setFilter(event.target.value)}
							placeholder="筛选停放项…"
							className="w-full rounded border border-border-subtle bg-bg-base px-2 py-1 text-micro outline-none"
						/>
					) : null}
					{visible.map((item) => (
						<div key={item.id} className="flex items-start gap-2">
							<span
								title={item.text}
								className="min-w-0 flex-1 truncate text-micro text-fg-muted"
							>
								{new Date(item.parkedAt).toLocaleTimeString()} · {item.text}
							</span>
							<button
								type="button"
								onClick={() => {
									composer.setText(item.text);
									useChatStore.getState().discardParked(activeId, item.id);
								}}
								className="shrink-0 text-micro text-fg-subtle hover:text-fg-default"
							>
								恢复
							</button>
							<button
								type="button"
								onClick={() =>
									useChatStore.getState().discardParked(activeId, item.id)
								}
								className="shrink-0 text-micro text-fg-subtle hover:text-status-danger"
							>
								丢弃
							</button>
						</div>
					))}
				</div>
			) : null}
		</div>
	);
}

/** 系统提议的下一步（TF-0095）：每个建议一次点击即发送，不要求打字。 */
function SuggestionChips() {
	const suggestions = useChatStore((s) => s.suggestions);
	const busy = useChatStore((s) => s.runningThreadId !== null);
	if (suggestions.length === 0) {
		return null;
	}
	const label: Record<string, string> = {
		option: "来自回答里的选项",
		question: "来自回答留下的问题",
		"next-step": "来自回答的下一步",
		diverge: "发散方向",
	};
	return (
		<div className="mx-6 mb-2 flex flex-wrap gap-1.5">
			{suggestions.map((suggestion) => (
				<button
					key={suggestion.text}
					type="button"
					disabled={busy}
					title={label[suggestion.kind] ?? suggestion.kind}
					onClick={() => void useChatStore.getState().send(suggestion.text)}
					className="max-w-full truncate rounded-full border border-border-subtle px-2.5 py-1 text-micro text-fg-muted hover:bg-muted hover:text-fg-default disabled:opacity-50"
				>
					{suggestion.text}
				</button>
			))}
		</div>
	);
}

/** composer 上方的安静层：恢复笔记 → 账本 → 停放快照 → 建议条。 */
export function ThreadSidecar() {
	return (
		<>
			<DraftMirror />
			<ResumeCard />
			<DecisionLedger />
			<ParkedBar />
			<SuggestionChips />
		</>
	);
}
