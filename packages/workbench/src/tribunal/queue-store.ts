import { join } from "node:path";
import { pathExists, safeReaddir } from "../fs/atomic";

import type { WorkbenchPaths } from "../paths";
import { type TribunalItem, tribunalItemSchema } from "../types/tribunal";
import { readYamlFile, writeYamlFile } from "../yamlio";

import {
	effectiveState,
	itemFile,
	PRIORITY_ORDER,
	type TribunalEvents,
} from "./queue-state";

/**
 * One read of the queue: what parsed, and the file names that did not.
 *
 * The unreadable list is the whole point of this shape. This queue exists to
 * hold the human decisions the system could not answer, so an item dropped
 * here is a decision that vanishes from every surface — and a queue missing
 * one item reads exactly like a queue with nothing to decide. The item stays
 * out of `items` (one bad file must not hide its siblings) but it is COUNTED
 * and named, so `workbench tribunal` and `GET /api/tribunal` can say
 * "N 条无法读取" instead of reporting a healthy queue.
 */
export interface TribunalQueueRead {
	items: TribunalItem[];
	/** File names under `tribunal/` that could not be parsed. */
	unreadable: string[];
}

export function tribunalStore(paths: WorkbenchPaths, events: TribunalEvents) {
	async function readAllReport(): Promise<TribunalQueueRead> {
		const names = (await safeReaddir(paths.tribunal)).filter((name) =>
			name.endsWith(".yaml"),
		);
		const results = await Promise.all(
			names.map(async (name) => {
				try {
					return {
						name,
						item: await readYamlFile(
							join(paths.tribunal, name),
							tribunalItemSchema,
						),
					};
				} catch {
					// torn or hand-edited file: the queue stays readable — but the
					// entry is recorded, never silently discarded.
					return { name, item: null };
				}
			}),
		);
		return {
			items: results.flatMap((entry) =>
				entry.item === null ? [] : [entry.item],
			),
			unreadable: results
				.filter((entry) => entry.item === null)
				.map((entry) => entry.name),
		};
	}

	async function readAll(): Promise<TribunalItem[]> {
		return (await readAllReport()).items;
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
	return {
		readAll,
		readAllReport,
		save,
		log,
		findTwin,
		listItems,
		getItem,
	};
}
