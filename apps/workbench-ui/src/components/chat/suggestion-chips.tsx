import { Lightbulb } from "lucide-react";
import { motion } from "motion/react";
import { useChatStore } from "../../chat/store";
import { FADE_IN, TWEEN_FAST } from "../../lib/motion";
import { Button } from "../ui/button";
import { Tooltip } from "../ui/tooltip";

const LABEL = {
	option: "来自回答里的选项",
	question: "来自回答留下的问题",
	"next-step": "来自回答的下一步",
	diverge: "发散方向",
};

export function SuggestionChips() {
	const suggestions = useChatStore((state) => state.suggestions);
	const busy = useChatStore((state) => state.runningThreadId !== null);
	if (suggestions.length === 0) return null;
	return (
		<motion.div
			{...FADE_IN}
			transition={TWEEN_FAST}
			className="mb-3 flex flex-wrap items-center gap-2"
		>
			<span className="inline-flex items-center gap-1.5 text-small text-fg-muted">
				<Lightbulb className="size-3.5" /> 接着做
			</span>
			{suggestions.map((suggestion) => (
				<Tooltip
					key={suggestion.kind + suggestion.text}
					content={LABEL[suggestion.kind]}
				>
					<Button
						variant="outline"
						size="sm"
						disabled={busy}
						onClick={() => void useChatStore.getState().send(suggestion.text)}
						className="max-w-full text-small font-normal text-fg-muted"
					>
						<span className="truncate">{suggestion.text}</span>
					</Button>
				</Tooltip>
			))}
		</motion.div>
	);
}
