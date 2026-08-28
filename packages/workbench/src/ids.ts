import { randomBytes } from "node:crypto";

/**
 * Collision-resistant id with a type prefix, e.g. `g-mgd3k1f9a2`.
 * Time bucket keeps ids roughly sortable; random suffix avoids same-millisecond
 * collisions across concurrent CLI invocations.
 */
export function newId(prefix: string): string {
	const time = Date.now().toString(36);
	const rand = randomBytes(4).toString("hex");
	return `${prefix}-${time}${rand}`;
}
