import { join } from "node:path";

import type { WorkbenchPaths } from "../paths";

export function sanitizeWriterId(id: string): string {
	return id.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function writerSpoolDir(
	paths: WorkbenchPaths,
	writerId: string,
): string {
	return join(paths.sessions, sanitizeWriterId(writerId), "spool");
}

export function legacyWriterSpoolDir(
	paths: WorkbenchPaths,
	writerId: string,
): string {
	return join(paths.root, "sessions", sanitizeWriterId(writerId), "spool");
}
