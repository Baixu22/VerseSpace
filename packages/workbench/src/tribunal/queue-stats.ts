import type { TribunalItem, TribunalPriority } from "../types/tribunal";

import { CRITICAL_SHARE_LIMIT, distributionHealthy } from "./kinds";

import { effectiveState, FLOOD_LIMIT, FLOOD_WINDOW_MS } from "./queue-state";
export async function queueStats(
	records: TribunalItem[],
	now = Date.now(),
): Promise<{
	open: number;
	shelved: number;
	pushable: number;
	admitted24h: number;
	pushed24h: number;
	resolved24h: number;
	ratePerHour: number;
	flood: boolean;
	floodCount: number;
	/** Total shelves ever recorded on open items — the deferral KPI. */
	shelves: number;
	criticalShare: number;
	rationalizationOk: boolean;
	distributionOk: boolean;
}> {
	const items = records.map((item) => effectiveState(item, now));
	const open = items.filter((item) => item.state !== "resolved");
	const in24h = items.filter(
		(item) => now - Date.parse(item.createdAt) <= 24 * 60 * 60_000,
	);
	const floodCount = in24h.filter(
		(item) => now - Date.parse(item.createdAt) <= FLOOD_WINDOW_MS,
	).length;
	const criticalShare =
		open.length === 0
			? 0
			: open.filter((item) => item.priority === "critical").length /
				open.length;
	return {
		open: open.filter((item) => item.state === "pending").length,
		shelved: open.filter((item) => item.state === "shelved").length,
		pushable: open.filter((item) => item.push).length,
		admitted24h: in24h.length,
		pushed24h: in24h.filter((item) => item.push).length,
		resolved24h: items.filter(
			(item) =>
				item.resolvedAt !== undefined &&
				now - Date.parse(item.resolvedAt) <= 24 * 60 * 60_000,
		).length,
		ratePerHour: in24h.length / 24,
		flood: floodCount >= FLOOD_LIMIT,
		floodCount,
		shelves: open.reduce((sum, item) => sum + item.shelveCount, 0),
		criticalShare,
		rationalizationOk: criticalShare <= CRITICAL_SHARE_LIMIT,
		distributionOk: distributionHealthy({
			critical: open.filter((item) => item.priority === "critical").length,
			high: open.filter((item) => item.priority === "high").length,
			medium: open.filter((item) => item.priority === "medium").length,
			low: open.filter((item) => item.priority === "low").length,
		}),
	};
}

export async function queueDistribution(
	records: TribunalItem[],
	now = Date.now(),
): Promise<Record<TribunalPriority, number> & { total: number }> {
	const open = records
		.map((item) => effectiveState(item, now))
		.filter((item) => item.state !== "resolved");
	const counts: Record<TribunalPriority, number> = {
		critical: 0,
		high: 0,
		medium: 0,
		low: 0,
	};
	for (const item of open) {
		counts[item.priority] += 1;
	}
	return { ...counts, total: open.length };
}
