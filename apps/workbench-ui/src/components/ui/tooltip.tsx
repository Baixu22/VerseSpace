import { Tooltip as TooltipPrimitive } from "radix-ui";
import type { ReactElement, ReactNode } from "react";

export function TooltipProvider({ children }: { children: ReactNode }) {
	return (
		<TooltipPrimitive.Provider delayDuration={400} skipDelayDuration={150}>
			{children}
		</TooltipPrimitive.Provider>
	);
}

export function Tooltip({
	children,
	content,
	side = "top",
}: {
	children: ReactElement;
	content: ReactNode;
	side?: "top" | "right" | "bottom" | "left";
}) {
	return (
		<TooltipPrimitive.Root>
			<TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
			<TooltipPrimitive.Portal>
				<TooltipPrimitive.Content
					side={side}
					sideOffset={8}
					collisionPadding={12}
					className="ui-tooltip z-[70] max-h-48 max-w-72 overflow-y-auto rounded-lg border border-border bg-bg-elevated px-3 py-2 text-small leading-relaxed text-fg-default shadow-lg [overflow-wrap:anywhere]"
				>
					{content}
				</TooltipPrimitive.Content>
			</TooltipPrimitive.Portal>
		</TooltipPrimitive.Root>
	);
}
