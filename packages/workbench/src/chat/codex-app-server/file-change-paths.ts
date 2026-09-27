import { asRecord } from "./protocol";

/**
 * Where does a `fileChange` approval's write target live? (TF-0263 follow-up.)
 *
 * ADR-0017's first 2026-09-27 补记 concluded that a real write turn never emits
 * a native write item. A 6-variant repetition on the same day falsified that:
 * variants 01 and 06 both emitted `fileChange` items. What that reading *did*
 * get right is that the approval is not self-describing — the real
 * `item/fileChange/requestApproval` params carry `threadId` / `turnId` /
 * `itemId` / `startedAtMs` / `reason` / `grantRoot` and **no path at all**
 * (fixture: `../fixtures/approvals/file-change-0.158.json`).
 *
 * The path is on the ITEM, under `changes[].path`, and the two are correlated by
 * `params.itemId`. This module reads that item shape; the caller owns the index
 * that remembers it across the turn. Nothing here touches the approval params,
 * which is why `approval-targets.ts` can stay pure and conservative.
 */

export interface FileChangeItemPaths {
	itemId: string;
	/** The turn the item was reported in — how the index scopes itself. */
	turnId: string | null;
	/** `changes[].path`, de-duplicated, in stream order. */
	paths: string[];
}

/**
 * The item id and changed paths of one `item/started` | `item/completed`
 * notification, or `null` when the event is not a path-bearing `fileChange`.
 */
export function fileChangeItemPaths(
	event: Record<string, unknown>,
): FileChangeItemPaths | null {
	const type = event.type;
	if (type !== "item/started" && type !== "item/completed") return null;
	const item = asRecord(event.item);
	if (item?.type !== "fileChange") return null;
	const itemId = typeof item.id === "string" ? item.id : "";
	if (!itemId) return null;
	const paths: string[] = [];
	for (const change of Array.isArray(item.changes) ? item.changes : []) {
		const path = asRecord(change)?.path;
		if (typeof path === "string" && path) paths.push(path);
	}
	if (paths.length === 0) return null;
	return {
		itemId,
		turnId: typeof event.turnId === "string" ? event.turnId : null,
		paths: [...new Set(paths)],
	};
}

/**
 * How many `fileChange` items one turn may pin. A turn emits one per change set,
 * so this only exists so a pathological stream cannot grow the map without
 * bound; eviction is oldest-first, keeping the freshest writes resolvable.
 */
export const MAX_TRACKED_FILE_CHANGES = 64;

/**
 * Bounded, turn-scoped `itemId → paths`. The session owns one instance; a new
 * turn id (or an explicit `clear()`) drops the previous turn's items, so the map
 * never spans turns.
 */
export class FileChangePathIndex {
	private readonly byItem = new Map<string, string[]>();
	private turnId: string | null = null;

	/** Record a notification; a non-`fileChange` event is ignored. */
	note(event: Record<string, unknown>): void {
		const found = fileChangeItemPaths(event);
		if (!found) return;
		if (found.turnId !== this.turnId) {
			this.byItem.clear();
			this.turnId = found.turnId;
		}
		this.byItem.set(found.itemId, found.paths);
		while (this.byItem.size > MAX_TRACKED_FILE_CHANGES) {
			const oldest = this.byItem.keys().next().value;
			if (oldest === undefined) break;
			this.byItem.delete(oldest);
		}
	}

	/** The paths the named item announced, or `[]` when it was never seen. */
	pathsFor(itemId: unknown): string[] {
		if (typeof itemId !== "string" || !itemId) return [];
		return this.byItem.get(itemId) ?? [];
	}

	/** Drop the tracked turn (called when a terminal turn frame arrives). */
	clear(): void {
		this.byItem.clear();
		this.turnId = null;
	}

	get size(): number {
		return this.byItem.size;
	}
}
