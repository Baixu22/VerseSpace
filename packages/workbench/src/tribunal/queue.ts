import { rm } from "node:fs/promises";
import { join } from "node:path";
import { pathExists, safeReaddir } from "../fs/atomic";
import { newId } from "../ids";
import type { WorkbenchPaths } from "../paths";
import {
	type SubmitResult,
	type TribunalCandidate,
	type TribunalItem,
	type TribunalPriority,
	tribunalItemSchema,
} from "../types/tribunal";
import { readYamlFile, writeYamlFile } from "../yamlio";
import {
	CRITICAL_SHARE_LIMIT,
	distributionHealthy,
	priorityOf,
	scoreOf,
} from "./kinds";
import { belowSoftFloor, rationalize } from "./rationalize";

/**
 * The adjudication queue (R3 / TF-0081). `notify_human` used to be an array
 * the runtime filled and nobody read; this is the thing that owns the
 * question "does a human need to decide this, and how soon".
 *
 * Storage follows the queue's convention — one file per item under
 * `state/tribunal/` — so two writers can never lose each other's item, and a
 * reader can list the queue while a decision is pending.
 *
 * Three behaviours carry the milestone:
 * - **first cause + causal suppression**: one invalidation that interrupts 30
 *   sessions is one item carrying 30 folded twins, not 30 alarms. The first
 *   one stays the item; later ones raise its severity if theirs is higher.
 * - **shelving expires**: a shelve is a deferral, not a discard. Bounded to
 *   5 minutes … 4 hours, and the queue reopens it when it lapses. How often a
 *   queue gets shelved is itself a KPI — a queue that is constantly shelved
 *   is mis-graded, not busy.
 * - **the gate is auditable**: rejections and folds are recorded as events, so
 *   the rationalization can be inspected instead of trusted.
 */

/** Twins of the same cause inside this window fold into the first one. */
export const AGGREGATION_WINDOW_MS = 30 * 60_000;
/** A deferral is bounded: shorter than this is a reflex, longer is avoidance. */
export const MIN_SHELVE_MINUTES = 5;
export const MAX_SHELVE_MINUTES = 4 * 60;
/** Human capacity: ~1 item / 10 min sustained, ~12 / hour ceiling. */
export const FLOOD_WINDOW_MS = 10 * 60_000;
export const FLOOD_LIMIT = 10;
export const RATE_LIMIT_PER_HOUR = 6;
export { CRITICAL_SHARE_LIMIT };
/** Resolved items are evidence, not state; keep them for a week. */
export const RESOLVED_RETENTION_MS = 7 * 24 * 60 * 60_000;

export interface TribunalEvents {
	append(event: {
		timestamp: string;
		source: string;
		type: string;
		payload: unknown;
	}): Promise<void>;
}

const PRIORITY_ORDER: Record<TribunalPriority, number> = {
	critical: 0,
	high: 1,
	medium: 2,
	low: 3,
};

function itemFile(paths: WorkbenchPaths, id: string): string {
	return join(paths.tribunal, `${id}.yaml`);
}

/** Shelve expiry is resolved at read time so a read-only view stays honest. */
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

export function tribunalApi(paths: WorkbenchPaths, events: TribunalEvents) {
	async function readAll(): Promise<TribunalItem[]> {
		const names = await safeReaddir(paths.tribunal);
		const items = await Promise.all(
			names
				.filter((name) => name.endsWith(".yaml"))
				.map(async (name) => {
					try {
						return await readYamlFile(
							join(paths.tribunal, name),
							tribunalItemSchema,
						);
					} catch {
						return null; // torn or hand-edited file: the queue stays readable
					}
				}),
		);
		return items.filter((item): item is TribunalItem => item !== null);
	}

	async function save(item: TribunalItem): Promise<TribunalItem> {
		await writeYamlFile(itemFile(paths, item.id), tribunalItemSchema, item);
		return item;
	}

	async function log(
		type: string,
		payload: unknown,
		at: string,
	): Promise<void> {
		await events.append({
			timestamp: at,
			source: "tribunal",
			type,
			payload,
		});
	}

	/**
	 * The open item that owns this cause, oldest first — "first cause wins".
	 * Shelved items count as open: a deferral is not a dismissal, and a twin
	 * arriving during the deferral must not start a second thread.
	 */
	async function findTwin(causeKey: string): Promise<TribunalItem | undefined> {
		const existing = await readAll();
		return existing
			.filter((item) => item.causeKey === causeKey)
			.filter((item) => effectiveState(item).state !== "resolved")
			.filter((item) => effectiveState(item).state !== "expired")
			.sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
	}

	async function listItems(includeResolved: boolean): Promise<TribunalItem[]> {
		const items = (await readAll()).map((item) => effectiveState(item));
		const open = includeResolved
			? items
			: items.filter((item) => item.state !== "resolved");
		return open.sort((a, b) => {
			const byPriority =
				PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
			if (byPriority !== 0) {
				return byPriority;
			}
			return a.createdAt.localeCompare(b.createdAt);
		});
	}

	async function getItem(id: string): Promise<TribunalItem | null> {
		const file = itemFile(paths, id);
		if (!(await pathExists(file))) {
			return null;
		}
		return effectiveState(await readYamlFile(file, tribunalItemSchema));
	}

	/**
	 * Start a new item for a cause the queue is not already carrying. The
	 * quantitative floor is checked HERE, never for a fold: an event with no
	 * twin that scores below the floor is not an alarm at all.
	 */
	async function createItem(
		draft: Omit<TribunalItem, "id">,
		at: string,
		episode: "first" | "new",
	): Promise<SubmitResult> {
		const floor = belowSoftFloor(draft);
		if (floor !== null) {
			await log(
				"tribunal_suppressed",
				{
					kind: draft.kind,
					subject: draft.subject,
					rule: "soft_floor",
					reason: floor,
					score: Number(draft.score.toFixed(3)),
				},
				at,
			);
			return { admitted: false, rule: "soft_floor", reason: floor };
		}
		const created: TribunalItem = { ...draft, id: newId("t") };
		await save(created);
		await log(
			"tribunal_admitted",
			{
				id: created.id,
				kind: created.kind,
				priority: created.priority,
				push: created.push,
				episode,
			},
			at,
		);
		return { admitted: true, item: created, folded: false };
	}

	return {
		/**
		 * Offer one event to the queue. Rationalization runs first; only what
		 * survives can be aggregated, shelved, or pushed.
		 */
		async submit(candidate: TribunalCandidate): Promise<SubmitResult> {
			const at = candidate.at ?? new Date().toISOString();
			const verdict = rationalize(candidate, at);
			if (!verdict.admit) {
				await log(
					"tribunal_suppressed",
					{
						kind: candidate.kind,
						subject: candidate.subject,
						rule: verdict.rule,
						reason: verdict.reason,
					},
					at,
				);
				return { admitted: false, ...verdict };
			}

			const draft = verdict.draft;
			const twin = await findTwin(draft.causeKey);

			if (twin) {
				const fresh =
					Date.parse(at) - Date.parse(twin.updatedAt) <= AGGREGATION_WINDOW_MS;
				if (!fresh) {
					// same cause, new episode: a fresh item beats an unbounded thread.
					// It is still a NEW item, so the soft floor applies to it.
					return createItem(draft, at, "new");
				}
				// first cause wins the item; a worse twin never lowers it
				const severity = Math.max(twin.severity, draft.severity);
				const urgencyMinutes = Math.min(
					twin.urgencyMinutes,
					draft.urgencyMinutes,
				);
				const score = Math.max(twin.score, scoreOf(severity, urgencyMinutes));
				const escalated = twin.escalated || draft.escalated;
				const merged: TribunalItem = {
					...twin,
					severity,
					urgencyMinutes,
					score,
					escalated,
					priority: priorityOf(score, escalated),
					push: twin.push || draft.push,
					escalationReason: draft.escalationReason ?? twin.escalationReason,
					folded: [
						...twin.folded,
						{
							subject: draft.subject,
							at,
							detail: candidate.detail ?? "",
						},
					],
					updatedAt: at,
				};
				await save(merged);
				await log(
					"tribunal_folded",
					{
						id: merged.id,
						causeKey: merged.causeKey,
						foldedCount: merged.folded.length,
						subject: draft.subject,
					},
					at,
				);
				return { admitted: true, item: merged, folded: true };
			}

			return createItem(draft, at, "first");
		},

		/** Open items, highest SLA first then oldest first. */
		async list(
			options: { includeResolved?: boolean } = {},
		): Promise<TribunalItem[]> {
			return listItems(options.includeResolved === true);
		},

		/** Items the human channel should actually interrupt for. */
		async pushable(): Promise<TribunalItem[]> {
			return (await listItems(false)).filter(
				(item) => item.push && item.state === "pending",
			);
		},

		async get(id: string): Promise<TribunalItem | null> {
			return getItem(id);
		},

		/**
		 * Defer an item. Bounded to 5 minutes … 4 hours: a shelve outside that
		 * range is either a reflex or avoidance, and both are worse than
		 * deciding now. The count is a KPI — `stats().shelves`.
		 */
		async shelve(id: string, minutes = 30): Promise<TribunalItem | null> {
			const item = await getItem(id);
			if (!item || item.state === "resolved") {
				return null;
			}
			const bounded = Math.min(
				MAX_SHELVE_MINUTES,
				Math.max(MIN_SHELVE_MINUTES, Math.trunc(minutes)),
			);
			const now = new Date().toISOString();
			const shelved: TribunalItem = {
				...item,
				state: "shelved",
				shelvedUntil: new Date(
					Date.parse(now) + bounded * 60_000,
				).toISOString(),
				shelveCount: item.shelveCount + 1,
				updatedAt: now,
			};
			await save(shelved);
			await log(
				"tribunal_shelved",
				{
					id,
					minutes: bounded,
					shelveCount: shelved.shelveCount,
				},
				now,
			);
			return shelved;
		},

		/** Record the decision. The item stays on disk as evidence for a week. */
		async resolve(id: string): Promise<TribunalItem | null> {
			const item = await getItem(id);
			if (!item || item.state === "resolved") {
				return null;
			}
			const now = new Date().toISOString();
			const resolved: TribunalItem = {
				...item,
				state: "resolved",
				shelvedUntil: undefined,
				resolvedAt: now,
				updatedAt: now,
			};
			await save(resolved);
			await log(
				"tribunal_resolved",
				{
					id,
					kind: resolved.kind,
					priority: resolved.priority,
					ageMinutes: Math.round(
						(Date.parse(now) - Date.parse(resolved.createdAt)) / 60_000,
					),
				},
				now,
			);
			return resolved;
		},

		/**
		 * Reopen lapsed deferrals and drop long-resolved items. Called once per
		 * runtime cycle — the single-writer run lock makes the rewrite safe.
		 */
		async expireShelved(now = Date.now()): Promise<number> {
			let reopened = 0;
			for (const item of await readAll()) {
				if (
					item.state === "shelved" &&
					item.shelvedUntil !== undefined &&
					Date.parse(item.shelvedUntil) <= now
				) {
					await save({
						...item,
						state: "pending",
						shelvedUntil: undefined,
						updatedAt: new Date(now).toISOString(),
					});
					reopened += 1;
					await log(
						"tribunal_shelve_expired",
						{
							id: item.id,
							shelveCount: item.shelveCount,
						},
						new Date(now).toISOString(),
					);
					continue;
				}
				if (
					item.state === "resolved" &&
					item.resolvedAt !== undefined &&
					now - Date.parse(item.resolvedAt) > RESOLVED_RETENTION_MS
				) {
					await rm(itemFile(paths, item.id), { force: true });
				}
			}
			return reopened;
		},

		/**
		 * The milestone's acceptance numbers (TF-0080): rate ≤ 6/hour, no
		 * flood, critical share ≤ 25%.
		 */
		async stats(now = Date.now()): Promise<{
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
			const items = (await readAll()).map((item) => effectiveState(item, now));
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
		},

		/**
		 * Priority mix of the open queue. A healthy queue after
		 * rationalization looks like 5 / 15 / 30 / 50.
		 */
		async distribution(
			now = Date.now(),
		): Promise<Record<TribunalPriority, number> & { total: number }> {
			const open = (await readAll())
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
		},
	};
}
