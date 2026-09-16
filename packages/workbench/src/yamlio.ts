import { readFile } from "node:fs/promises";
import { parse, stringify } from "yaml";
import type { ZodType } from "zod";
import { BlackboardDataError } from "./errors";
import { writeFileAtomic } from "./fs/atomic";

/**
 * Parse + validate one YAML file. Validation errors are wrapped with the file
 * path so `doctor` and the CLI can point at the offending file directly.
 */
export async function readYamlFile<T>(
	path: string,
	schema: ZodType<T>,
): Promise<T> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new BlackboardDataError("file not found", path);
		}
		throw new BlackboardDataError(`cannot read YAML: ${String(error)}`, path);
	}
	let data: unknown;
	try {
		data = parse(raw);
	} catch (error) {
		throw new BlackboardDataError(
			`invalid YAML: ${(error as Error).message}`,
			path,
		);
	}
	const result = schema.safeParse(data);
	if (!result.success) {
		const issues = result.error.issues
			.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
			.join("; ");
		throw new BlackboardDataError(`schema validation failed (${issues})`, path);
	}
	return result.data;
}

/**
 * Validate (filling schema defaults) then atomically persist as YAML. The
 * value is re-parsed through the schema so every write lands in canonical
 * shape, not just the fields the caller happened to set.
 */
export async function writeYamlFile<T>(
	path: string,
	schema: ZodType<T>,
	value: T,
): Promise<void> {
	const canonical = schema.parse(value);
	await writeFileAtomic(path, stringify(canonical));
}
