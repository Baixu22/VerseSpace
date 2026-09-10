import type { WorkbenchEvent } from "../types/event";

export function eventPayload(event: WorkbenchEvent): Record<string, unknown> {
	return event.payload &&
		typeof event.payload === "object" &&
		!Array.isArray(event.payload)
		? (event.payload as Record<string, unknown>)
		: {};
}

export function stringValue(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function eventOrder(event: WorkbenchEvent, index: number): number {
	return Number.isSafeInteger(event.eventSeq)
		? (event.eventSeq as number)
		: Number.isSafeInteger(event.seq)
			? (event.seq as number)
			: index;
}

export function orderedEvents(events: WorkbenchEvent[]): WorkbenchEvent[] {
	return events
		.map((event, index) => ({ event, index }))
		.sort((a, b) => {
			const order = eventOrder(a.event, a.index) - eventOrder(b.event, b.index);
			return order || a.event.timestamp.localeCompare(b.event.timestamp);
		})
		.map(({ event }) => event);
}
