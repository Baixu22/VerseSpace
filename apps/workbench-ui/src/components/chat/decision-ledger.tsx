import { BookOpenText, ChevronDown } from "lucide-react";
import { motion } from "motion/react";
import { useState } from "react";
import { useChatStore } from "../../chat/store";
import { STAGGER_CHILD, STAGGER_PARENT, TWEEN_FAST } from "../../lib/motion";
import { AnimatedDisclosure } from "./animated-disclosure";

/** 决策账本：自动填充、默认折叠、无分歧时完全不渲染。 */
export function DecisionLedger() {
	const points = useChatStore((s) => s.decisionPoints);
	const [expanded, setExpanded] = useState(false);
	if (points.length === 0) return null;
	return (
		<motion.section className="mb-3 rounded-xl border border-border-subtle bg-bg-base/80 px-3 py-2">
			<button
				type="button"
				aria-expanded={expanded}
				onClick={() => setExpanded(!expanded)}
				className="flex w-full cursor-pointer items-center gap-2 text-left"
			>
				<BookOpenText className="size-3.5 text-fg-subtle" />
				<span className="text-small font-medium text-fg-muted">决策账本</span>
				<span className="rounded-full bg-muted px-1.5 text-small text-fg-subtle">
					{points.length}
				</span>
				<motion.span
					className="ml-auto text-fg-subtle"
					animate={{ rotate: expanded ? 180 : 0 }}
					transition={TWEEN_FAST}
				>
					<ChevronDown className="size-3.5" />
				</motion.span>
			</button>
			<AnimatedDisclosure open={expanded}>
				<motion.ul
					initial="hidden"
					animate="show"
					variants={STAGGER_PARENT}
					className="mt-2 space-y-1.5 border-t border-border-subtle pt-2"
				>
					{points.map((point) => (
						<motion.li
							key={`${point.kind}-${point.messageId}`}
							variants={STAGGER_CHILD}
							className="flex items-center gap-2 text-small text-fg-muted"
						>
							<span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-fg-subtle">
								{point.kind === "fork"
									? `分叉 ×${point.count}`
									: `备选 ×${point.count}`}
							</span>
							<span className="flex-1 truncate">{point.preview}</span>
						</motion.li>
					))}
				</motion.ul>
			</AnimatedDisclosure>
		</motion.section>
	);
}
