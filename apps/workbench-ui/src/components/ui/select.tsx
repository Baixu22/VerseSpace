import { Select as SelectPrimitive } from "radix-ui";
import { Check, ChevronDown, ChevronUp } from "@/components/icon";

interface SelectOption {
	value: string;
	label: string;
	description?: string;
}

export function Select({
	id,
	value,
	onValueChange,
	options,
	describedBy,
}: {
	id: string;
	value: string;
	onValueChange: (value: string) => void;
	options: readonly SelectOption[];
	describedBy?: string;
}) {
	return (
		<SelectPrimitive.Root value={value} onValueChange={onValueChange}>
			<SelectPrimitive.Trigger
				id={id}
				aria-describedby={describedBy}
				className="ui-control ui-field group/select flex cursor-pointer items-center justify-between gap-3 text-left hover:border-border-default hover:bg-bg-elevated focus-visible:outline-none data-[state=open]:border-ring/60 data-[state=open]:ring-2 data-[state=open]:ring-ring/10 [&>span:first-child]:truncate"
			>
				<SelectPrimitive.Value />
				<SelectPrimitive.Icon asChild>
					<ChevronDown
						className="ui-control size-4 shrink-0 text-fg-muted group-data-[state=open]/select:rotate-180"
						strokeWidth={1.75}
					/>
				</SelectPrimitive.Icon>
			</SelectPrimitive.Trigger>
			<SelectPrimitive.Portal>
				<SelectPrimitive.Content
					position="popper"
					align="start"
					sideOffset={6}
					collisionPadding={12}
					className="ui-select z-[60] max-h-[var(--radix-select-content-available-height)] w-[var(--radix-select-trigger-width)] min-w-0 overflow-hidden rounded-xl border border-border bg-bg-elevated p-1.5 shadow-xl"
				>
					<SelectPrimitive.ScrollUpButton className="flex h-6 items-center justify-center text-fg-muted">
						<ChevronUp className="size-3.5" />
					</SelectPrimitive.ScrollUpButton>
					<SelectPrimitive.Viewport>
						{options.map((option) => (
							<SelectPrimitive.Item
								key={option.value}
								value={option.value}
								textValue={option.label}
								aria-describedby={
									option.description
										? `${id}-${option.value}-description`
										: undefined
								}
								className="ui-control relative flex cursor-pointer select-none flex-col gap-1 rounded-lg py-2.5 pl-3 pr-9 outline-none data-[highlighted]:bg-muted data-[highlighted]:text-fg-default data-[disabled]:pointer-events-none data-[disabled]:opacity-40"
							>
								<SelectPrimitive.ItemText>
									<span className="text-ui font-medium leading-5">
										{option.label}
									</span>
								</SelectPrimitive.ItemText>
								{option.description ? (
									<span
										id={`${id}-${option.value}-description`}
										className="text-small leading-relaxed text-fg-muted"
									>
										{option.description}
									</span>
								) : null}
								<SelectPrimitive.ItemIndicator className="absolute right-3 top-3.5 text-fg-default">
									<Check className="size-3.5" strokeWidth={2} />
								</SelectPrimitive.ItemIndicator>
							</SelectPrimitive.Item>
						))}
					</SelectPrimitive.Viewport>
					<SelectPrimitive.ScrollDownButton className="flex h-6 items-center justify-center text-fg-muted">
						<ChevronDown className="size-3.5" />
					</SelectPrimitive.ScrollDownButton>
				</SelectPrimitive.Content>
			</SelectPrimitive.Portal>
		</SelectPrimitive.Root>
	);
}
