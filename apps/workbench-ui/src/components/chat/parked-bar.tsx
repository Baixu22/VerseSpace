import { unstable_useComposerInput } from "@assistant-ui/react";
import { ArchiveRestore, ChevronDown, Search, Trash2, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { useChatStore } from "../../chat/store";
import { STAGGER_CHILD, STAGGER_PARENT, TWEEN_FAST } from "../../lib/motion";
import { Button } from "../ui/button";
import { Tooltip } from "../ui/tooltip";
import { AnimatedDisclosure } from "./animated-disclosure";

/** 停放快照：返回车道时可恢复或丢弃。 */
export function ParkedBar() {
	const activeId = useChatStore((s) => s.activeId);
	const items = useChatStore((s) =>
		s.activeId ? s.parked[s.activeId] : undefined,
	);
	const composer = unstable_useComposerInput();
	const [filter, setFilter] = useState("");
	const [expanded, setExpanded] = useState(false);
	if (!activeId || !items || items.length === 0) return null;
	const visible = filter
		? items.filter((item) => item.text.includes(filter))
		: items;
	return (
		<motion.section className="mb-3 rounded-xl border border-border-subtle bg-bg-surface px-3 py-2">
			<div className="flex items-center gap-2">
				<button
					type="button"
					aria-expanded={expanded}
					onClick={() => setExpanded(!expanded)}
					className="flex cursor-pointer items-center gap-2 text-left"
				>
					<ArchiveRestore className="size-3.5 text-fg-subtle" />
					<span className="text-small font-medium text-fg-muted">停放快照</span>
					<span className="rounded-full bg-muted px-1.5 text-small text-fg-subtle">
						{items.length}
					</span>
					<motion.span
						animate={{ rotate: expanded ? 180 : 0 }}
						transition={TWEEN_FAST}
						className="text-fg-subtle"
					>
						<ChevronDown className="size-3.5" />
					</motion.span>
				</button>
				<span className="hidden flex-1 text-small text-fg-subtle sm:inline">
					切换离开时自动收起
				</span>
				<Tooltip content="丢弃全部停放项">
					<Button
						type="button"
						variant="ghost"
						size="xs"
						className="ml-auto text-fg-muted hover:text-status-danger"
						onClick={() => useChatStore.getState().clearParked(activeId)}
					>
						<Trash2 className="size-3" />
						全部丢弃
					</Button>
				</Tooltip>
			</div>
			<AnimatedDisclosure open={expanded}>
				<div className="mt-2 border-t border-border-subtle pt-2">
					{items.length > 1 ? (
						<label className="flex items-center gap-2 rounded-md border border-border-subtle bg-bg-base px-2 text-fg-subtle focus-within:ring-2 focus-within:ring-ring/30">
							<Search className="size-3" />
							<input
								value={filter}
								onChange={(event) => setFilter(event.target.value)}
								placeholder="筛选停放项…"
								className="min-w-0 flex-1 bg-transparent py-1 text-small text-fg-default outline-none"
							/>
						</label>
					) : null}
					<motion.div
						initial="hidden"
						animate="show"
						variants={STAGGER_PARENT}
						className="mt-1.5 space-y-1"
					>
						<AnimatePresence initial={false}>
							{visible.map((item) => (
								<motion.div
									key={item.id}
									variants={STAGGER_CHILD}
									exit={{ opacity: 0, x: -8, height: 0 }}
									className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-muted/60"
								>
									<Tooltip content={item.text}>
										<span className="min-w-0 flex-1 truncate text-small text-fg-muted">
											{new Date(item.parkedAt).toLocaleTimeString()} ·{" "}
											{item.text}
										</span>
									</Tooltip>
									<Button
										type="button"
										variant="ghost"
										size="xs"
										onClick={() => {
											composer.setText(item.text);
											useChatStore.getState().discardParked(activeId, item.id);
										}}
									>
										恢复
									</Button>
									<Tooltip content="丢弃这条草稿">
										<Button
											type="button"
											variant="ghost"
											size="icon"
											className="size-6 text-fg-subtle hover:text-status-danger"
											aria-label="丢弃"
											onClick={() =>
												useChatStore.getState().discardParked(activeId, item.id)
											}
										>
											<X className="size-3" />
										</Button>
									</Tooltip>
								</motion.div>
							))}
						</AnimatePresence>
					</motion.div>
				</div>
			</AnimatedDisclosure>
		</motion.section>
	);
}
