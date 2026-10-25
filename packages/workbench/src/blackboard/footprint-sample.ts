import { createHash, randomUUID } from "node:crypto";
import {
	mkdir,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { hashText } from "../hash";
import { tierOf } from "../runtime/durability";
import {
	inputContentHash,
	normalizeInput,
	type ReturnedInput,
} from "./input-content";
import type { FootprintUsed, ReadSpan } from "./session-types";

const HASH_CAP_BYTES = 2_000_000;
const SPOOL_CAP_BYTES = 64_000;
const SPOOL_KEEP = 20;

/** One buffer supplies full-file hash, range hash and spool; never mix read versions. */
async function samplePath(
	projectRoot: string,
	path: string,
	spoolDir?: string,
	span?: ReadSpan,
): Promise<{ claim: FootprintUsed; text?: string; reason?: string }> {
	const unified = path.replace(/\\/g, "/");
	const rel = isAbsolute(unified)
		? relative(projectRoot, unified).replace(/\\/g, "/")
		: unified;
	const normalized =
		rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : unified;
	const claim: FootprintUsed = {
		path: normalized,
		version: null,
		durability: tierOf(normalized),
	};
	try {
		const abs = isAbsolute(normalized)
			? normalized
			: join(projectRoot, normalized);
		const before = await stat(abs);
		if (!before.isFile()) return { claim, reason: "目录采样不是文件内容观察" };
		if (before.size > HASH_CAP_BYTES)
			return { claim: { ...claim, size: before.size } };
		const bytes = await readFile(abs);
		const after = await stat(abs);
		if (bytes.length > HASH_CAP_BYTES)
			return { claim: { ...claim, size: bytes.length } };
		const version = createHash("sha256").update(bytes).digest("hex");
		const stable =
			before.size === after.size &&
			after.size === bytes.length &&
			before.mtimeMs === after.mtimeMs &&
			before.ctimeMs === after.ctimeMs;
		const text = bytes.toString("utf8");
		claim.version = version;
		claim.observation = {
			schemaVersion: 1,
			source: "fs-sample",
			sample: { version, stable },
		};
		if (span) {
			const lines = text
				.split("\n")
				.slice(Math.max(0, span.start - 1), span.end);
			claim.span = {
				start: span.start,
				end: span.end,
				hash: lines.length ? hashText(lines.join("\n")) : null,
			};
		}
		if (
			spoolDir &&
			claim.durability === "volatile" &&
			bytes.length <= SPOOL_CAP_BYTES
		) {
			claim.spool = await spoolRead(spoolDir, text, normalized);
		}
		return {
			claim,
			...(Buffer.from(text, "utf8").equals(bytes) ? { text } : {}),
		};
	} catch {
		return { claim };
	}
}

/** Stable filesystem sampling is useful evidence, but never a returned-content receipt. */
export async function hashPathClaim(
	projectRoot: string,
	path: string,
	spoolDir?: string,
	span?: ReadSpan,
): Promise<FootprintUsed> {
	return (await samplePath(projectRoot, path, spoolDir, span)).claim;
}

export async function captureReturnedInput(
	projectRoot: string,
	path: string,
	returned: ReturnedInput,
	spoolDir?: string,
	previousSpan?: ReadSpan,
): Promise<FootprintUsed> {
	const span =
		"selector" in returned && returned.selector.kind === "lines"
			? returned.selector
			: previousSpan;
	const { claim, text, reason } = await samplePath(
		projectRoot,
		path,
		spoolDir,
		span,
	);
	const unknown = (reason: string) => ({
		...claim,
		observation: {
			schemaVersion: 1 as const,
			source: "unknown" as const,
			reason,
		},
	});
	if ("reason" in returned) return unknown(returned.reason);
	if (reason) return unknown(reason);
	if (claim.size !== undefined)
		return unknown("大文件仅有 size，不能绑定返回内容");
	if (
		Buffer.byteLength(returned.returned, "utf8") > HASH_CAP_BYTES ||
		/\[truncated\]|Warning: truncated output|output truncated|output was truncated/i.test(
			returned.returned,
		)
	) {
		return unknown("返回内容过大或已截断");
	}
	const sample =
		claim.observation?.source === "fs-sample"
			? claim.observation.sample
			: undefined;
	const selected =
		text === undefined
			? undefined
			: returned.selector.kind === "file"
				? text
				: normalizeInput(text)
						.split("\n")
						.slice(returned.selector.start - 1, returned.selector.end)
						.join("\n");
	claim.observation = {
		schemaVersion: 1,
		source: "tool-observed",
		returnedHash: hashText(returned.returned),
		contentHash: inputContentHash(returned.content),
		selector: returned.selector,
		normalization: "utf8-lines-v1",
		...(sample && selected !== undefined
			? { sample: { ...sample, contentHash: inputContentHash(selected) } }
			: {}),
	};
	return claim;
}

/** Legacy premise line hashes keep their original byte/newline semantics. */
export async function hashLines(
	absPath: string,
	start: number,
	end: number,
): Promise<string | null> {
	try {
		const lines = (await readFile(absPath, "utf8"))
			.split("\n")
			.slice(Math.max(0, start - 1), end);
		return lines.length ? hashText(lines.join("\n")) : null;
	} catch {
		return null;
	}
}

async function spoolRead(
	spoolDir: string,
	content: string,
	normalizedPath: string,
): Promise<string> {
	await mkdir(spoolDir, { recursive: true });
	const safeName = normalizedPath.replace(/[^A-Za-z0-9._-]/g, "_").slice(-80);
	const name = `${Date.now().toString(36)}-${randomUUID()}-${safeName}`;
	await writeFile(join(spoolDir, name), content, "utf8");
	const names = (await readdir(spoolDir)).sort();
	for (const old of names.slice(0, Math.max(0, names.length - SPOOL_KEEP))) {
		await rm(join(spoolDir, old), { force: true }).catch(() => {});
	}
	return name;
}
