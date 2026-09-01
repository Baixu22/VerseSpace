import { hashText } from "../hash";

/**
 * Export-surface projection (R2 predicate layer 3, TF-0076).
 *
 * The same trick as Gradle compilation avoidance and TypeScript's shape
 * signatures: hash what consumers can actually observe — the ordered list of
 * exported names, kinds, and signature text — and keep everything volatile
 * (method bodies, comments, whitespace, private members, positions) out of
 * the projection. Change a function body without touching its signature and
 * the surface does not move, so nobody who merely imported it needs to hear
 * about it.
 *
 * Deliberately NOT tree-sitter. The tags.scm route is the rigorous one, but
 * it is a native dependency, and this project's whole positioning is
 * zero-heavy-dependency. The red line from the task is that one projection
 * bug means ~1000x over-notification and the channel dies on day one — so the
 * projection here is intentionally conservative: plain lexical scanning, no
 * types resolved, no transitive closure. When in doubt it declines to answer
 * (returns null / reports "changed") rather than guessing, because erring
 * toward notifying is survivable and erring toward silence is not.
 */

const SURFACE_KINDS =
	/^export\s+(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(function|const|let|var|class|interface|type|enum)\b/;

/**
 * Strip comments while respecting string and template literals. Replaced with
 * newlines rather than nothing, so a comment never accidentally splices two
 * tokens together.
 */
export function stripComments(source: string): string {
	let out = "";
	let i = 0;
	type Mode = "code" | "line" | "block" | "single" | "double" | "template";
	let mode: Mode = "code";
	while (i < source.length) {
		const ch = source[i]!;
		const next = source[i + 1];
		switch (mode) {
			case "code":
				if (ch === "/" && next === "/") {
					mode = "line";
					i += 2;
					continue;
				}
				if (ch === "/" && next === "*") {
					mode = "block";
					i += 2;
					out += " ";
					continue;
				}
				if (ch === "'" || ch === '"' || ch === "`") {
					mode = ch === "'" ? "single" : ch === '"' ? "double" : "template";
					out += ch;
					i += 1;
					continue;
				}
				out += ch;
				i += 1;
				continue;
			case "line":
				if (ch === "\n") {
					mode = "code";
					out += ch;
				}
				i += 1;
				continue;
			case "block":
				if (ch === "*" && next === "/") {
					mode = "code";
					i += 2;
					out += " ";
					continue;
				}
				if (ch === "\n") {
					out += ch;
				}
				i += 1;
				continue;
			default: {
				const quote = mode === "single" ? "'" : mode === "double" ? '"' : "`";
				out += ch;
				i += 1;
				if (ch === "\\") {
					out += source[i] ?? "";
					i += 1;
					continue;
				}
				if (ch === quote) {
					mode = "code";
				}
				continue;
			}
		}
	}
	return out;
}

function isStatementStart(text: string, at: number): boolean {
	let k = at - 1;
	while (k >= 0 && /\s/.test(text[k]!)) {
		k -= 1;
	}
	return k < 0 || text[k] === ";" || text[k] === "}" || text[k] === "{";
}

/**
 * Slice one export declaration. Bodies are excluded for functions and
 * classes; interface/enum members are included, because those ARE part of
 * what consumers see.
 */
function readDeclaration(text: string, at: number): string | null {
	const match = SURFACE_KINDS.exec(text.slice(at, at + 160));
	if (!match) {
		return null;
	}
	const kind = match[1]!;
	let curly = 0;
	let paren = 0;
	let i = at;
	while (i < text.length) {
		const ch = text[i]!;
		if (ch === "(") {
			paren += 1;
		} else if (ch === ")") {
			paren -= 1;
		} else if (ch === "{") {
			if (curly === 0 && (kind === "function" || kind === "class")) {
				return text.slice(at, i); // body starts here
			}
			curly += 1;
		} else if (ch === "}") {
			curly -= 1;
			if (curly === 0 && (kind === "interface" || kind === "enum")) {
				return text.slice(at, i + 1);
			}
		} else if (ch === "=" && curly === 0 && paren === 0) {
			if (kind === "const" || kind === "let" || kind === "var") {
				return text.slice(at, i); // name + type annotation, not the value
			}
		} else if (ch === ";" && curly === 0 && paren === 0) {
			if (
				kind === "type" ||
				kind === "const" ||
				kind === "let" ||
				kind === "var"
			) {
				return text.slice(at, i + 1);
			}
		}
		i += 1;
	}
	return null; // unterminated: don't guess
}

function normalize(signature: string): string {
	return signature.replace(/\s+/g, " ").trim();
}

/**
 * The ordered export signatures of a module. Whitespace, comments, bodies,
 * and positions are all outside the projection.
 */
export function exportSurface(source: string): string[] {
	const text = stripComments(source);
	const surfaces: string[] = [];
	let i = 0;
	for (;;) {
		const at = text.indexOf("export", i);
		if (at === -1) {
			break;
		}
		if (!isStatementStart(text, at)) {
			i = at + 6;
			continue;
		}
		const declaration = readDeclaration(text, at);
		if (declaration === null) {
			i = at + 6;
			continue;
		}
		const normalized = normalize(declaration);
		if (normalized) {
			surfaces.push(normalized);
		}
		i = at + Math.max(declaration.length, 6);
	}
	return surfaces;
}

/** null means "no opinion" — the caller must treat that as possibly changed. */
export function surfaceHash(source: string): string | null {
	const surface = exportSurface(source);
	if (surface.length === 0) {
		return null;
	}
	return hashText(surface.join("\n"));
}
