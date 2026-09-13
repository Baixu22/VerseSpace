/**
 * Pull code-element references out of an agent instruction file.
 *
 * The academic claim behind TF-0104 is narrow: instruction files
 * (CLAUDE.md / AGENTS.md / .cursorrules) cite code that later moves or
 * dies, and a surprising fraction of those citations go stale. The
 * citations that can be checked without an AST are the path-shaped ones —
 * `src/foo.ts`, `packages/workbench/src/cli.ts`, a markdown link to a
 * file. Identifiers without a path (`runDoctor`) are not assertions we
 * can falsify from the filesystem, so they are not counted.
 *
 * Fenced ``` blocks are examples, not citations; only inline `code` and
 * markdown links count.
 */

export interface ExtractedRef {
	/** Normalized repo-relative or basename path (forward slashes). */
	ref: string;
	/** 1-based line of the first occurrence in this file. */
	line: number;
	kind: "path" | "file";
}

const FENCE = /```[\s\S]*?```/g;

/** Inline `...` that looks like a path or a source filename. */
const BACKTICK = /`([^`\n]{1,240})`/g;

/** Markdown link to a relative file. */
const MD_LINK = /\[[^\]]*?\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/** Bare repo-relative path with a known root segment and an extension. */
const BARE_PATH =
	/(?<![`\w./])((?:src|lib|packages|apps|scripts|docs|sidecar|e2e|src-tauri|crates|services)\/[\w./-]+\.\w+)\b/g;

const FILE_EXT =
	/\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts|rs|py|go|java|kt|swift|md|mdc|json|toml|yml|yaml|css|html|svg|sql|proto|graphql|sh|ps1)$/i;

/**
 * Classic placeholder names (foo.rs / src/foo.test.ts / foo/mod.rs / foo/)
 * are teaching examples inside the instruction file, not architecture
 * assertions. Counting them buries the real stale citations in noise
 * (issue #2: they were 5 of the 11 "stale" refs on the helmor AGENTS.md).
 */
const PLACEHOLDER_SEGMENTS = new Set(["foo", "bar", "baz"]);

function isPlaceholderRef(ref: string): boolean {
	return ref
		.replace(/\/+$/, "")
		.split("/")
		.some((segment) => {
			const base = segment.toLowerCase();
			return (
				PLACEHOLDER_SEGMENTS.has(base) ||
				[...PLACEHOLDER_SEGMENTS].some((name) => base.startsWith(`${name}.`))
			);
		});
}

export function extractRefs(markdown: string): ExtractedRef[] {
	const text = markdown.replace(FENCE, (block) =>
		"\n".repeat(newlinesIn(block)),
	);
	const found = new Map<string, ExtractedRef>();

	const consider = (raw: string, index: number, kind: ExtractedRef["kind"]) => {
		const ref = normalizeRef(raw);
		if (!ref || found.has(ref)) {
			return;
		}
		if (!isPathShaped(ref, kind)) {
			return;
		}
		if (isPlaceholderRef(ref)) {
			return;
		}
		found.set(ref, { ref, line: lineOf(text, index), kind });
	};

	for (const match of text.matchAll(BACKTICK)) {
		const raw = match[1] ?? "";
		const kind: ExtractedRef["kind"] = raw.includes("/") ? "path" : "file";
		consider(raw, match.index ?? 0, kind);
	}
	for (const match of text.matchAll(MD_LINK)) {
		const raw = match[1] ?? "";
		if (
			raw.startsWith("http://") ||
			raw.startsWith("https://") ||
			raw.startsWith("#") ||
			raw.startsWith("mailto:")
		) {
			continue;
		}
		consider(raw, match.index ?? 0, raw.includes("/") ? "path" : "file");
	}
	for (const match of text.matchAll(BARE_PATH)) {
		consider(match[1] ?? "", match.index ?? 0, "path");
	}

	return [...found.values()].sort((a, b) => a.line - b.line);
}

export function normalizeRef(raw: string): string | null {
	let value = raw.trim().replace(/\\/g, "/");
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		value = value.slice(1, -1);
	}
	value = value.replace(/^\.\//, "").replace(/\/+/g, "/");
	value = value.replace(/[.,;:!?)]+$/, "");
	if (value.startsWith("/")) {
		value = value.slice(1);
	}
	if (!value || value.length > 240) {
		return null;
	}
	if (
		value.startsWith("~") ||
		value.startsWith("$") ||
		value.startsWith("--")
	) {
		return null;
	}
	if (
		/[<>{}*]/.test(value) ||
		value.includes("\u2026") ||
		value.includes("...")
	) {
		return null;
	}
	if (value.startsWith("http://") || value.startsWith("https://")) {
		return null;
	}
	if (value.includes("://")) {
		return null;
	}
	if (value.includes(" ")) {
		return null;
	}
	if (value.startsWith("@") && !value.includes(".")) {
		return null; // npm scope without a file
	}
	return value;
}

function isPathShaped(ref: string, kind: ExtractedRef["kind"]): boolean {
	if (ref.includes("..")) {
		return false;
	}
	if (kind === "path") {
		return ref.includes("/") && !ref.startsWith("#");
	}
	return FILE_EXT.test(ref) && !ref.includes("/");
}

function lineOf(text: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index; i++) {
		if (text[i] === "\n") {
			line += 1;
		}
	}
	return line;
}

function newlinesIn(text: string): number {
	let n = 0;
	for (const ch of text) {
		if (ch === "\n") {
			n += 1;
		}
	}
	return n;
}
