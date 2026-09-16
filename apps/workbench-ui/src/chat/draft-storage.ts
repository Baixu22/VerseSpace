import type { ParkedItem } from "./message-types";

const PARKED_STORAGE_KEY = "workbench.chat.parked.v1";

export function loadParked(): Record<string, ParkedItem[]> {
	try {
		const storage = globalThis.localStorage;
		if (!storage) {
			return {};
		}
		const parsed: unknown = JSON.parse(
			storage.getItem(PARKED_STORAGE_KEY) ?? "{}",
		);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return {};
		}
		const result: Record<string, ParkedItem[]> = {};
		for (const [threadId, value] of Object.entries(parsed)) {
			if (!Array.isArray(value)) {
				continue;
			}
			const items = value.filter(
				(item): item is ParkedItem =>
					Boolean(item) &&
					typeof item === "object" &&
					(item as ParkedItem).kind === "draft" &&
					typeof (item as ParkedItem).id === "string" &&
					typeof (item as ParkedItem).text === "string" &&
					typeof (item as ParkedItem).parkedAt === "string",
			);
			if (items.length > 0) {
				result[threadId] = items;
			}
		}
		return result;
	} catch {
		// Private browsing and disabled webviews can reject storage access.
		return {};
	}
}

export function persistParked(parked: Record<string, ParkedItem[]>): void {
	try {
		globalThis.localStorage?.setItem(
			PARKED_STORAGE_KEY,
			JSON.stringify(parked),
		);
	} catch {
		// A full/disabled storage area must not block composing or switching.
	}
}
