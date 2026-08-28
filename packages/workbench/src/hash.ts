import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export async function hashFile(path: string): Promise<string> {
	const data = await readFile(path);
	return createHash("sha256").update(data).digest("hex");
}
