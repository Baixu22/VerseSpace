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
export function tribunalStore(paths: WorkbenchPaths, events: TribunalEvents) {
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
	return { readAll, save, log, findTwin, listItems, getItem };
}
