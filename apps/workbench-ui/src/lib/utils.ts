import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// Mirrors the root src/lib/utils.ts: register the typography tokens with
// tailwind-merge so text-* utilities don't collapse into colors.
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
