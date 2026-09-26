/**
 * Relative-link resolution — the upload-surface gate's second reading.
 *
 * WHY THIS FILE EXISTS (issue #37)
 * --------------------------------
 * `referenced-but-local` decides "a shipped doc points at a local-only doc" by
 * SUBSTRING matching (`text.includes(local)`). That probe only works when the
 * referrer happens to spell the target as a repo-relative path, so two real
 * classes of broken reference passed the gate silently:
 *
 * 1. **Relative spelling.** An ADR that writes `../positioning-v5.md` contains
 *    no `docs/positioning-v5.md` substring, so the substring probe never sees
 *    it at all.
 * 2. **Wrong relative depth.** When
 *    `docs/handoff/qa-stage-ab-remediation-2026-09-25.md` moved into
 *    `docs/handoff/`, its links were not re-based: 24 links all pointed at
 *    non-existent `docs/packages/…`, and `--strict-references` still reported 0
 *    violations, exit 0.
 *
 * This module answers a DIFFERENT and mechanical question — *does the target of
 * a relative link exist on disk?* — and answers it by resolving the target
 * against the directory of the referring file. The two readings are
 * complementary, not redundant: the substring probe can spot a repo-relative
 * pointer at a local-only doc and ask a human to adjudicate it, while this one
 * cannot tell whether an existing target ships. Keep both.
 *
 * SCOPE: ONLY THE UPLOAD SURFACE
 * ------------------------------
 * Only `.md` files in the `uploaded` list (tracked ∪ untracked-not-ignored) are
 * checked. Local-only / ignored docs are deliberately NOT checked: a cloner
 * never sees them, and the gate's subject is what a cloner receives. A dead
 * link inside a document that stays on this machine is not a defect of the
 * upload surface.
 *
 * WHAT IS NOT COVERED (stated plainly, so silence is not read as a decision)
 * -------------------------------------------------------------------------
 * - Reference-style links (`[label][ref]` plus a `[ref]: target` definition)
 *   and autolinks (`<https://…>`).
 * - HTML (`<a href>`, `<img src>`).
 * - Targets that contain a space and are NOT wrapped in `<…>` — that is not a
 *   valid inline link, and guessing at it would manufacture false violations.
 * - Links in files that are not `.md` (source comments, JSON, …).
 * - Anchors: `docs/a.md#section` is only checked down to `docs/a.md`; a
 *   fragment that names no heading is not detected.
 * - Case: resolution uses the host filesystem. On Windows `Docs/A.md` resolves
 *   case-insensitively, so a case mismatch that would break on a
 *   case-sensitive clone is NOT reported here.
 * - Local-only / ignored docs, by the scope decision above.
 *
 * The resolution half is pure (strings in, strings out) so it is testable on a
 * host that denies `node` a child process; only `checkRelativeLinks` touches the
 * filesystem.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";

/** A Markdown file larger than this is not scanned, mirroring the gate. */
const MAX_SCAN_BYTES = 1_000_000;

/**
 * Inline links: `[label](target)`, `[label](<target>)`, `[label](target "title")`
 * and the image form `![label](target)` — the image's inner `[label](…)` matches
 * the same pattern, and an image target is a real path that must resolve too.
 *
 * The target is `[^()\s]+` rather than `[^)]+` on purpose: a bare target with a
 * space is malformed, and swallowing it would report a path nobody wrote.
 */
const INLINE_LINK =
	/\[[^\]\n]*\]\(\s*(<[^<>\n]*>|[^()\s]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?\s*\)/g;

/** A URL scheme prefix: `http:`, `https:`, `mailto:`, `data:`, `tel:`, … */
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * Drop fenced code blocks. A link written inside ``` is an example, not a
 * pointer a reader follows, so resolving it would only manufacture noise.
 * An unclosed fence swallows the rest of the file — the same reading CommonMark
 * takes.
 */
export function stripCodeFences(markdown) {
	const kept = [];
	let fence = null;
	for (const line of String(markdown).split(/\r?\n/)) {
		const marker = /^\s*(`{3,}|~{3,})/.exec(line);
		if (fence === null) {
			if (marker) {
				fence = { char: marker[1][0], length: marker[1].length };
				continue;
			}
			kept.push(line.replace(/`[^`\n]*`/g, ""));
		} else if (
			marker &&
			marker[1][0] === fence.char &&
			marker[1].length >= fence.length
		) {
			fence = null;
		}
	}
	return kept.join("\n");
}

/** Every inline link target in a Markdown document, in document order. */
export function extractLinkTargets(markdown) {
	const targets = [];
	for (const match of stripCodeFences(markdown).matchAll(INLINE_LINK)) {
		targets.push(match[1]);
	}
	return targets;
}

/**
 * Parse a raw link target into the path it names, or `null` when it is not a
 * relative filesystem reference at all.
 *
 * Ignored: empty targets, bare fragments (`#anchor`), protocol-relative `//…`,
 * root-absolute `/…`, and anything carrying a URL scheme. A trailing
 * `#fragment` and `?query` are stripped before resolving, and the remainder is
 * percent-decoded (`%20` → space).
 */
export function parseLinkTarget(raw) {
	let target = String(raw ?? "").trim();
	if (target.startsWith("<") && target.endsWith(">")) {
		target = target.slice(1, -1).trim();
	}
	if (target === "" || target.startsWith("/") || SCHEME.test(target)) {
		return null;
	}
	const cut = target.search(/[#?]/);
	if (cut !== -1) {
		target = target.slice(0, cut);
	}
	if (target === "") {
		return null;
	}
	let decoded = target;
	try {
		decoded = decodeURIComponent(target);
	} catch {
		// A lone `%` is not an escape; fall back to the literal text.
		decoded = target;
	}
	return { raw: String(raw ?? "").trim(), target: decoded.replace(/\\/g, "/") };
}

/**
 * Resolve a raw target against the directory of the referring file, using
 * forward slashes. Returns `null` for a target `parseLinkTarget` ignored.
 *
 * `resolved` is canonical: a trailing slash is dropped, so `docs/handoff/` and
 * `docs/handoff` name the same directory and the report shows one spelling.
 * A `resolved` that still starts with `../` escaped the repository root, so no
 * clone can contain it — callers report it as broken.
 */
export function resolveLinkTarget(fromPath, raw) {
	const parsed = parseLinkTarget(raw);
	if (parsed === null) {
		return null;
	}
	const from = String(fromPath).replace(/\\/g, "/");
	const joined = posix.normalize(
		posix.join(posix.dirname(from), parsed.target),
	);
	return { ...parsed, resolved: joined.replace(/\/+$/, "") };
}

/** Does the resolved repo-relative path name a file or a directory on disk? */
function existsInRoot(root, resolved) {
	if (resolved === "" || resolved === "." || resolved.startsWith("../")) {
		return false;
	}
	return existsSync(join(root, resolved));
}

/**
 * Resolve every relative link in every uploaded `.md` file.
 *
 * `files` is the gate's `uploaded` list — tracked ∪ untracked-not-ignored. Files
 * that are not `.md`, absent from the working tree, or above `MAX_SCAN_BYTES`
 * are skipped, exactly as the substring probe skips them.
 *
 * Returns `{ checked, broken }`: `checked` is the list of every relative link
 * that was resolved (the gate reports its length), `broken` is the list of
 * violation entries, one per dead link, ready to push onto `report.violations`.
 */
export function checkRelativeLinks({ root, files = [] }) {
	const checked = [];
	const broken = [];
	for (const path of files) {
		if (!String(path).endsWith(".md")) {
			continue;
		}
		const full = join(root, path);
		let text;
		try {
			if (statSync(full).size > MAX_SCAN_BYTES) {
				continue;
			}
			text = readFileSync(full, "utf8");
		} catch {
			// A tracked path can be absent from the working tree (sparse
			// checkout, or deleted but not staged). Absence is not a link defect.
			continue;
		}
		for (const raw of extractLinkTargets(text)) {
			const link = resolveLinkTarget(path, raw);
			if (link === null) {
				continue;
			}
			checked.push({ path, ...link });
			if (!existsInRoot(root, link.resolved)) {
				broken.push({
					code: "broken-relative-link",
					side: "uploaded",
					path,
					target: link.resolved,
					raw: link.raw,
					detail: `相对链接解析为 ${link.resolved}，磁盘上不存在该文件或目录（原文 ${link.raw}）`,
				});
			}
		}
	}
	return { checked, broken };
}
