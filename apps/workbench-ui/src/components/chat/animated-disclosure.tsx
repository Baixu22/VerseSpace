import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { TWEEN_DISCLOSURE } from "../../lib/motion";

export function AnimatedDisclosure({
	open,
	children,
}: {
	open: boolean;
	children: ReactNode;
}) {
	const reducedMotion = useReducedMotion();
	return (
		<AnimatePresence initial={false}>
			{open ? (
				<motion.div
					initial={{ height: 0, opacity: 0 }}
					animate={{ height: "auto", opacity: 1 }}
					exit={{ height: 0, opacity: 0 }}
					transition={reducedMotion ? { duration: 0 } : TWEEN_DISCLOSURE}
					className="overflow-hidden"
				>
					{children}
				</motion.div>
			) : null}
		</AnimatePresence>
	);
}
