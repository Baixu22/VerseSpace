import type { Transition } from "motion/react";

// Keep these durations in sync with styles/interactions.css.
export const EASE_OUT_EXPO = [0.16, 1, 0.3, 1] as const;
export const TWEEN_FAST: Transition = {
	type: "tween",
	duration: 0.14,
	ease: EASE_OUT_EXPO,
};
export const TWEEN_DISCLOSURE: Transition = {
	type: "tween",
	duration: 0.18,
	ease: EASE_OUT_EXPO,
};
export const FADE_IN = {
	initial: { opacity: 0, y: 3 },
	animate: { opacity: 1, y: 0 },
	exit: { opacity: 0, y: -3 },
} as const;
export const STAGGER_PARENT = {
	hidden: {},
	show: { transition: { staggerChildren: 0.02 } },
} as const;
export const STAGGER_CHILD = {
	hidden: { opacity: 0, y: 3 },
	show: { opacity: 1, y: 0, transition: TWEEN_FAST },
} as const;
