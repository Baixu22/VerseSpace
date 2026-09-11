import { Dialog } from "radix-ui";
import type { ComponentProps } from "react";
import { X } from "@/components/icon";
import { cn } from "../../lib/utils";
import { Button } from "./button";

export const Sheet = Dialog.Root;
export const SheetTrigger = Dialog.Trigger;

export function SheetContent({
	title,
	description,
	side = "right",
	children,
	className,
	...props
}: ComponentProps<typeof Dialog.Content> & {
	title: string;
	description: string;
	side?: "left" | "right";
}) {
	return (
		<Dialog.Portal>
			<Dialog.Overlay className="ui-overlay fixed inset-0 z-40 bg-black/45" />
			<Dialog.Content
				data-side={side}
				className={cn(
					"ui-sheet fixed inset-y-0 z-50 flex w-full max-w-[26rem] flex-col bg-bg-surface shadow-xl outline-none",
					side === "left"
						? "left-0 max-w-[min(20rem,calc(100%-3rem))] border-r border-border"
						: "right-0 border-l border-border",
					className,
				)}
				{...props}
			>
				<div className="flex shrink-0 items-start gap-3 border-b border-border-subtle px-5 py-4">
					<div className="min-w-0 flex-1">
						<Dialog.Title className="text-heading font-semibold tracking-tight">
							{title}
						</Dialog.Title>
						<Dialog.Description className="mt-1 text-small leading-relaxed text-fg-muted">
							{description}
						</Dialog.Description>
					</div>
					<Dialog.Close asChild>
						<Button variant="ghost" size="sm" aria-label="关闭">
							<X className="size-3.5" />
							关闭
						</Button>
					</Dialog.Close>
				</div>
				{children}
			</Dialog.Content>
		</Dialog.Portal>
	);
}
