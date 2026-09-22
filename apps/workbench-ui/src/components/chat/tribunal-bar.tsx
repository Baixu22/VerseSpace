import { motion } from "motion/react";
import { useState } from "react";
import {
	AlertTriangle,
	ChevronDown,
	CircleCheck,
	Clock,
} from "@/components/icon";
import type { TribunalItemView } from "../../chat/message-types";
import { useChatStore } from "../../chat/store";
import { STAGGER_CHILD, STAGGER_PARENT, TWEEN_FAST } from "../../lib/motion";
import { Button } from "../ui/button";
import { AnimatedDisclosure } from "./animated-disclosure";

const PRIORITY_LABEL: Record<TribunalItemView["priority"], string> = {
	critical: "紧急",
	high: "高",
	medium: "中",
	low: "低",
};

/**
 * 裁决队列（TF-0242）：账本「答不了、交给人」的通道，内嵌在对话里而不是另开面板。
 * 全局队列，不随线程切换；无待裁决项时完全不渲染。resolve / shelve 走与 CLI
 * 相同的账本路径，产生 tribunal_resolved / tribunal_shelved 事件。
 */
export function TribunalBar() {
	const items = useChatStore((s) => s.tribunalItems);
	const resolve = useChatStore((s) => s.resolveTribunal);
	const shelve = useChatStore((s) => s.shelveTribunal);
	const [expandedId, setExpandedId] = useState<string | null>(null);
	const [busyId, setBusyId] = useState<string | null>(null);
	if (items.length === 0) return null;

	const act = async (id: string, run: () => Promise<void>) => {
		setBusyId(id);
		try {
			await run();
		} finally {
			setBusyId((current) => (current === id ? null : current));
		}
	};

	return (
		<motion.section className="mb-3 rounded-xl border border-status-warning/40 bg-status-warning/5 px-3 py-2">
			<div className="flex items-center gap-2">
				<AlertTriangle className="size-3.5 text-status-warning" />
				<span className="text-small font-medium text-fg-muted">待裁决</span>
				<span className="rounded-full bg-status-warning/20 px-1.5 text-small text-status-warning">
					{items.length}
				</span>
			</div>
			<motion.ul
				initial="hidden"
				animate="show"
				variants={STAGGER_PARENT}
				className="mt-2 space-y-1.5"
			>
				{items.map((item) => {
					const open = expandedId === item.id;
					const busy = busyId === item.id;
					return (
						<motion.li
							key={item.id}
							variants={STAGGER_CHILD}
							className="rounded-lg border border-border-subtle bg-bg-base/60 px-2.5 py-2"
						>
							<button
								type="button"
								aria-expanded={open}
								onClick={() => setExpandedId(open ? null : item.id)}
								className="flex w-full cursor-pointer items-center gap-2 text-left"
							>
								<span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-nano text-fg-subtle">
									{PRIORITY_LABEL[item.priority]}
								</span>
								<span className="flex-1 truncate text-small text-fg-default">
									{item.sbar.recommendation}
								</span>
								{item.state === "shelved" ? (
									<Clock className="size-3 shrink-0 text-fg-subtle" />
								) : null}
								<motion.span
									className="text-fg-subtle"
									animate={{ rotate: open ? 180 : 0 }}
									transition={TWEEN_FAST}
								>
									<ChevronDown className="size-3.5" />
								</motion.span>
							</button>
							<AnimatedDisclosure open={open}>
								<div className="space-y-1 border-t border-border-subtle pt-2 text-small text-fg-muted">
									<p>
										<span className="text-fg-subtle">对象</span> {item.subject}
									</p>
									<p>
										<span className="text-fg-subtle">S</span>{" "}
										{item.sbar.situation}
									</p>
									<p>
										<span className="text-fg-subtle">B</span>{" "}
										{item.sbar.background}
									</p>
									<p>
										<span className="text-fg-subtle">A</span>{" "}
										{item.sbar.assessment}
									</p>
									<p>
										<span className="text-fg-subtle">R</span>{" "}
										{item.sbar.recommendation}
									</p>
									<p className="text-fg-subtle">动作：{item.action.label}</p>
									<div className="flex gap-2 pt-1">
										<Button
											size="sm"
											variant="outline"
											disabled={busy}
											onClick={() => act(item.id, () => resolve(item.id))}
										>
											<CircleCheck className="size-3.5" /> 裁决
										</Button>
										<Button
											size="sm"
											variant="ghost"
											disabled={busy}
											onClick={() => act(item.id, () => shelve(item.id))}
										>
											<Clock className="size-3.5" /> 推迟
										</Button>
									</div>
								</div>
							</AnimatedDisclosure>
						</motion.li>
					);
				})}
			</motion.ul>
		</motion.section>
	);
}
