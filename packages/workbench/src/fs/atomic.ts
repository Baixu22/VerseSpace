import { randomBytes } from "node:crypto";
import {
	appendFile,
	mkdir,
	readdir,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";

/** Directory listing that treats a missing directory as empty. */
export async function safeReaddir(dir: string): Promise<string[]> {
	try {
		return await readdir(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}
		throw error;
	}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function renameWithRetry(
	from: string,
	to: string,
	attempts = 5,
): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			await rename(from, to);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			// Windows: EPERM/EACCES when the destination is briefly locked
			// (antivirus, indexer). Back off and retry before giving up.
			const retriable = code === "EPERM" || code === "EACCES";
			if (!retriable || attempt >= attempts - 1) {
				throw error;
			}
			await sleep(5 * 2 ** attempt);
		}
	}
}

/**
 * POSIX-style atomic replace: write a sibling temp file, then rename it over
 * the destination. Readers see either the old or the new file, never a half
 * write. The temp file lives in the same directory so the rename stays on one
 * volume.
 */
export async function writeFileAtomic(
	filePath: string,
	data: string,
): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	const temp = `${filePath}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		await writeFile(temp, data, "utf8");
		await renameWithRetry(temp, filePath);
	} catch (error) {
		await rm(temp, { force: true });
		throw error;
	}
}

export async function appendJsonlLine(
	filePath: string,
	value: unknown,
): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	await appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

export async function pathExists(target: string): Promise<boolean> {
	try {
		await stat(target);
		return true;
	} catch {
		return false;
	}
}
