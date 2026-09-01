/**
 * Durability tiers (R2, predicate layer 1 — TF-0074, after Salsa):
 * generated/vendor trees are `durable` — their content is reproducible from
 * sources, so a change to them cannot invalidate anyone's premise. Only
 * `volatile` (source) claims enter premise checking. Pure precision gain,
 * zero recall loss, O(1) per write, no dependencies.
 */

const DURABLE_SEGMENTS = [
	"node_modules/",
	"vendor/",
	"dist/",
	"build/",
	"out/",
	"coverage/",
	".workbench/",
	".git/",
	"target/", // rust
	"__pycache__/",
];

/**
 * A segment matches when it appears as a directory boundary anywhere in the
 * path (`app/dist/main.js`) or as the first segment of a relative path
 * (`dist/main.js`). The second case matters because agents report relative
 * paths, and a repo-root `dist/` or `.git/` is just as reproducible as a
 * nested one — matching only the leading-slash form silently puts those
 * reads back into premise checking.
 */
function matchesSegment(path: string, segment: string): boolean {
	return path.includes(`/${segment}`) || path.startsWith(segment);
}

/** Generated-file suffixes that are reproducible from sources. */
const DURABLE_SUFFIXES = [".min.js", ".min.css", ".map", ".lockb", ".d.ts.map"];

export type Durability = "volatile" | "durable";

export function tierOf(path: string): Durability {
	const normalized = path.replace(/\\/g, "/");
	for (const segment of DURABLE_SEGMENTS) {
		if (matchesSegment(normalized, segment)) {
			return "durable";
		}
	}
	for (const suffix of DURABLE_SUFFIXES) {
		if (normalized.endsWith(suffix)) {
			return "durable";
		}
	}
	return "volatile";
}
