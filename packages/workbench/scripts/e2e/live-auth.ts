import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Markers written only by the live E2E runners. Never accept an empty file. */
export const LIVE_AUTH_MARKERS = [
	"isolated-live-model-fixture",
	"tenant-live-model-accumulation",
] as const;

export async function assertLiveAuthorized(
	root: string,
	message = "缺少隔离工作区授权标记",
): Promise<string> {
	const marker = (
		await readFile(join(root, ".live-e2e-authorized"), "utf8")
	).trim();
	if (!(LIVE_AUTH_MARKERS as readonly string[]).includes(marker))
		throw new Error(message);
	return marker;
}
