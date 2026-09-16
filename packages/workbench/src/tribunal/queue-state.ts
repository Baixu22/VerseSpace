import { join } from "node:path";

import type { WorkbenchPaths } from "../paths";
import type { TribunalItem, TribunalPriority } from "../types/tribunal";

export const AGGREGATION_WINDOW_MS = 30 * 60_000;

export const MIN_SHELVE_MINUTES = 5;

export const MAX_SHELVE_MINUTES = 4 * 60;

export const FLOOD_WINDOW_MS = 10 * 60_000;

export const FLOOD_LIMIT = 10;

export const RATE_LIMIT_PER_HOUR = 6;

export { CRITICAL_SHARE_LIMIT } from "./kinds";

export const RESOLVED_RETENTION_MS = 7 * 24 * 60 * 60_000;

export interface TribunalEvents {
	append(event: {
		timestamp: string;
		source: string;
		type: string;
		payload: unknown;
	}): Promise<void>;
}

export const PRIORITY_ORDER: Record<TribunalPriority, number> = {
	critical: 0,
	high: 1,
	medium: 2,
	low: 3,
};

export function itemFile(paths: WorkbenchPaths, id: string): string {
	return join(paths.tribunal, `${id}.yaml`);
}

export function effectiveState(
	item: TribunalItem,
	now = Date.now(),
): TribunalItem {
	if (
		item.state === "shelved" &&
		item.shelvedUntil !== undefined &&
		Date.parse(item.shelvedUntil) <= now
	) {
		return { ...item, state: "pending", shelvedUntil: undefined };
	}
	return item;
}
