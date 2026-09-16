import type { Blackboard } from "../blackboard";

export function event(
	bb: Blackboard,
	type: string,
	payload: unknown,
): Promise<void> {
	return bb.events
		.append({
			timestamp: new Date().toISOString(),
			source: "runtime",
			type,
			payload,
		})
		.then(() => undefined);
}
