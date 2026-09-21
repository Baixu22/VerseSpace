import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// Register the typography tokens with tailwind-merge so text-* utilities
// don't collapse into colors. The legacy `src/lib/utils.ts` this used to
// mirror was retired on 2026-09-21 (ADR-0015); this is now the only copy.
const twMerge = extendTailwindMerge({
	extend: {
		classGroups: {
			"font-size": [
				{
					text: [
						"nano",
						"micro",
						"mini",
						"small",
						"ui",
						"body",
						"title",
						"heading",
					],
				},
			],
		},
	},
});

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}
