import { rm } from "node:fs/promises";

import { newId } from "../ids";
import type { WorkbenchPaths } from "../paths";
import type {
	SubmitResult,
	TribunalCandidate,
	TribunalItem,
} from "../types/tribunal";

import { priorityOf, scoreOf } from "./kinds";
import {
	AGGREGATION_WINDOW_MS,
	itemFile,
	MAX_SHELVE_MINUTES,
	MIN_SHELVE_MINUTES,
	RESOLVED_RETENTION_MS,
	type TribunalEvents,
} from "./queue-state";
import { queueDistribution, queueStats } from "./queue-stats";
import { tribunalStore } from "./queue-store";
import { belowSoftFloor, rationalize } from "./rationalize";

export type { TribunalEvents } from "./queue-state";
export {
	AGGREGATION_WINDOW_MS,
	CRITICAL_SHARE_LIMIT,
	effectiveState,
	MAX_SHELVE_MINUTES,
	MIN_SHELVE_MINUTES,
	RATE_LIMIT_PER_HOUR,
	RESOLVED_RETENTION_MS,
} from "./queue-state";
export function tribunalApi(paths: WorkbenchPaths, events: TribunalEvents) {
	const { readAll, readAllReport, save, log, findTwin, listItems, getItem } =
		tribunalStore(paths, events);
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

		async list(
			options: { includeResolved?: boolean } = {},
		): Promise<TribunalItem[]> {
			return listItems(options.includeResolved === true);
		},

		async pushable(): Promise<TribunalItem[]> {
			return (await listItems(false)).filter(
				(item) => item.push && item.state === "pending",
			);
		},

		async get(id: string): Promise<TribunalItem | null> {
			return getItem(id);
		},

		/**
		 * 无法解析的队列文件名（损坏或被手工编辑）。队列本身照常可读——一个坏
		 * 文件不能藏起其余条目——但这些条目必须被**报出来**：把「读不出来」
		 * 呈现成「队列是空的」，等于把一条人类决策从所有界面上抹掉。
		 * `workbench tribunal` 与 `GET /api/tribunal` 据此显示「N 条无法读取」。
		 */
		async unreadable(): Promise<string[]> {
			return (await readAllReport()).unreadable;
		},

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

		async stats(now = Date.now()) {
			return queueStats(await readAll(), now);
		},

		async distribution(now = Date.now()) {
			return queueDistribution(await readAll(), now);
		},
	};
}
