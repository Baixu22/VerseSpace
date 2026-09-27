/**
 * Tests for relative-link resolution — the upload-surface gate's second reading
 * (issue #37).
 *
 * The gate already had a `referenced-but-local` probe, but it decides by
 * SUBSTRING (`text.includes(local)`), so it cannot see `../positioning-v5.md`
 * and cannot see a whole file's worth of links left at the wrong depth. These
 * are the assertions the new `broken-relative-link` violation rests on:
 *
 *   - a relative target resolves against the directory of the REFERRING file,
 *     which is both the rule this gate specifies and GitHub's real behaviour;
 *   - the wrong relative depth is caught (the 24 `docs/packages/…` links from
 *     the moved stage A+B report);
 *   - `#fragment`, `?query`, `<…>` and `%20` are handled before resolving;
 *   - external / protocol-relative / root-absolute / fragment-only targets are
 *     not "broken links" and are not counted;
 *   - a directory target resolves;
 *   - and the REAL repo's baseline is pinned, so a second broken link cannot
 *     slip in unnoticed.
 *
 * Run: node --test scripts/upload-surface/links.test.mjs
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	checkRelativeLinks,
	extractLinkTargets,
	parseLinkTarget,
	resolveLinkTarget,
} from "./links.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");

/** Build a throwaway tree; `files` maps a repo-relative path to its contents. */
function withTree(files, run) {
	const root = mkdtempSync(join(tmpdir(), "upload-links-"));
	try {
		for (const [path, text] of Object.entries(files)) {
			const full = join(root, path);
			mkdirSync(dirname(full), { recursive: true });
			writeFileSync(full, text, "utf8");
		}
		return run(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test("extract: inline links, images, angle brackets and titles", () => {
	const markdown = [
		"see [a](docs/a.md) and ![img](assets/i.png)",
		"[spaced](<docs/with space.md>)",
		'[titled](docs/b.md "the title")',
	].join("\n");
	assert.deepEqual(extractLinkTargets(markdown), [
		"docs/a.md",
		"assets/i.png",
		"<docs/with space.md>",
		"docs/b.md",
	]);
});

test("extract: a link inside a code fence or an inline span is an example, not a pointer", () => {
	const markdown = [
		"```md",
		"[dead](docs/nope.md)",
		"```",
		"and `[dead](docs/nope2.md)` inline",
		"[live](docs/yes.md)",
	].join("\n");
	assert.deepEqual(extractLinkTargets(markdown), ["docs/yes.md"]);
});

test("resolve: a relative target resolves against the referring file's directory", () => {
	assert.equal(
		resolveLinkTarget("docs/handoff/a.md", "../b.md").resolved,
		"docs/b.md",
	);
	assert.equal(
		resolveLinkTarget("docs/handoff/a.md", "../../packages/x.ts").resolved,
		"packages/x.ts",
	);
	assert.equal(
		resolveLinkTarget("README.md", "docs/a.md").resolved,
		"docs/a.md",
	);
	// The ADR spelling issue #37 names: no `docs/positioning-v5.md` substring
	// anywhere, so the substring probe could never have seen this reference.
	assert.equal(
		resolveLinkTarget("docs/decisions/0023-x.md", "../positioning-v5.md")
			.resolved,
		"docs/positioning-v5.md",
	);
});

test("resolve: the wrong relative depth lands somewhere else entirely", () => {
	// The defect issue #37 records: qa-stage-ab-remediation-2026-09-25.md moved
	// into docs/handoff/ and kept its links spelled from the docs/ root, so all
	// 24 resolved under docs/handoff/packages/… — and the substring gate still
	// reported 0 violations, exit 0.
	assert.equal(
		resolveLinkTarget("docs/handoff/qa.md", "packages/workbench/src/cli.ts")
			.resolved,
		"docs/handoff/packages/workbench/src/cli.ts",
	);
	// the same link, correctly re-based:
	assert.equal(
		resolveLinkTarget(
			"docs/handoff/qa.md",
			"../../packages/workbench/src/cli.ts",
		).resolved,
		"packages/workbench/src/cli.ts",
	);
});

test("parse: `#fragment` and `?query` are stripped before resolving", () => {
	assert.deepEqual(parseLinkTarget("docs/a.md#L20-L33"), {
		raw: "docs/a.md#L20-L33",
		target: "docs/a.md",
	});
	assert.equal(parseLinkTarget("docs/a.md?x=1#y").target, "docs/a.md");
	assert.equal(parseLinkTarget("docs/a.md#").target, "docs/a.md");
	// A bare fragment names a heading in the referring document, not a path.
	assert.equal(parseLinkTarget("#anchor"), null);
});

test("parse: `<…>` wrapping and percent-decoding", () => {
	assert.equal(
		parseLinkTarget("<docs/with space.md>").target,
		"docs/with space.md",
	);
	assert.equal(
		parseLinkTarget("docs/with%20space.md").target,
		"docs/with space.md",
	);
	// A lone `%` is not an escape; the literal text is the path.
	assert.equal(parseLinkTarget("docs/100%.md").target, "docs/100%.md");
});

test("parse: non-relative targets are not this check's business", () => {
	for (const raw of [
		"https://example.com/a.md",
		"http://example.com",
		"mailto:someone@example.com",
		"data:text/plain,hi",
		"//host/x.md",
		"/docs/a.md",
		"#anchor",
		"",
		"   ",
	]) {
		assert.equal(parseLinkTarget(raw), null, raw);
	}
});

test("check: a broken relative link is a violation entry the gate can push as-is", () => {
	withTree({ "docs/a.md": "[dead](b.md)\n" }, (root) => {
		const { checked, broken } = checkRelativeLinks({
			root,
			files: ["docs/a.md"],
		});
		assert.equal(checked.length, 1);
		assert.equal(broken.length, 1);
		assert.equal(broken[0].code, "broken-relative-link");
		assert.equal(broken[0].side, "uploaded");
		assert.equal(broken[0].path, "docs/a.md");
		assert.equal(broken[0].target, "docs/b.md");
		assert.equal(broken[0].raw, "b.md");
		// The detail has to name both the resolved target and the raw spelling,
		// otherwise a reader cannot tell a typo from a stale re-base.
		assert.ok(broken[0].detail.includes("docs/b.md"));
		assert.ok(broken[0].detail.includes("b.md"));
	});
});

test("check: the wrong depth is reported while the right depth resolves", () => {
	withTree(
		{
			"packages/x.ts": "export {};\n",
			"docs/handoff/wrong.md": "[a](packages/x.ts)\n",
			"docs/handoff/right.md": "[a](../../packages/x.ts)\n",
		},
		(root) => {
			const { checked, broken } = checkRelativeLinks({
				root,
				files: ["docs/handoff/wrong.md", "docs/handoff/right.md"],
			});
			assert.equal(checked.length, 2);
			assert.equal(broken.length, 1);
			assert.equal(broken[0].path, "docs/handoff/wrong.md");
			assert.equal(broken[0].target, "docs/handoff/packages/x.ts");
			assert.equal(broken[0].raw, "packages/x.ts");
		},
	);
});

test("check: external, protocol-relative, root-absolute and fragment links are not counted", () => {
	withTree(
		{
			"a.md": [
				"[e](https://example.com/x.md)",
				"[m](mailto:someone@example.com)",
				"[p](//host/x.md)",
				"[r](/docs/nope.md)",
				"[f](#section)",
				"",
			].join("\n"),
		},
		(root) => {
			const { checked, broken } = checkRelativeLinks({ root, files: ["a.md"] });
			assert.equal(checked.length, 0);
			assert.equal(broken.length, 0);
		},
	);
});

test("check: a directory target resolves, a missing one does not", () => {
	withTree(
		{
			"docs/handoff/README.md": "# hi\n",
			"a.md": "[dir](docs/handoff/)\n[missing](docs/nope/)\n",
		},
		(root) => {
			const { checked, broken } = checkRelativeLinks({ root, files: ["a.md"] });
			assert.equal(checked.length, 2);
			// The trailing slash is dropped, so the report shows one canonical
			// spelling for the directory either way it was written.
			assert.equal(checked[0].resolved, "docs/handoff");
			assert.deepEqual(
				broken.map((entry) => entry.target),
				["docs/nope"],
			);
		},
	);
});

test("check: a target that escapes the repository root is broken", () => {
	// No clone can contain `../..` above the repo, so resolving it against the
	// host filesystem would be a false pass — and on a machine where the parent
	// directory happens to hold that name, a flaky one.
	withTree({ "a.md": "[up](../../outside.md)\n" }, (root) => {
		const { broken } = checkRelativeLinks({ root, files: ["a.md"] });
		assert.equal(broken.length, 1);
		assert.equal(broken[0].target, "../../outside.md");
	});
});

test("check: only `.md` files are read", () => {
	withTree(
		{ "a.txt": "[dead](nope.md)\n", "b.md": "[ok](a.txt)\n" },
		(root) => {
			const { checked, broken } = checkRelativeLinks({
				root,
				files: ["a.txt", "b.md"],
			});
			assert.equal(checked.length, 1);
			assert.equal(broken.length, 0);
		},
	);
});

/**
 * The upload surface: tracked ∪ untracked-not-ignored, the same list the gate
 * uses. `git ls-files` is the honest source; the DSH sandbox denies node a
 * child process (`spawnSync git EPERM`), so fall back to the lists the gate's
 * own `--lists` path reads.
 */
function uploadedFiles() {
	const split = (text) =>
		text
			.split(/\r?\n/)
			.map((line) => line.trim().replace(/\\/g, "/"))
			.filter(Boolean);
	try {
		const run = (args) =>
			execFileSync("git", args, {
				cwd: REPO,
				encoding: "utf8",
				maxBuffer: 1 << 28,
			});
		return [
			...split(run(["ls-files"])),
			...split(run(["ls-files", "--others", "--exclude-standard"])),
		];
	} catch {
		const dir = join(REPO, ".agent-contexts", "upload-lists");
		return [
			...split(readFileSync(join(dir, "tracked.txt"), "utf8")),
			...split(readFileSync(join(dir, "untracked.txt"), "utf8")),
		];
	}
}

/**
 * The pinned baseline: the real repo has ZERO broken relative links.
 *
 * This is a ratchet, not a formality. On 2026-09-26 the check's first real run
 * found exactly one defect the old substring probe could not see —
 * `.github/pull_request_template.md` linked to
 * `docs/decisions/0018-single-ci-channel-jihulab.md`, which from `.github/`
 * resolves to a path that does not exist. It was fixed to
 * `../docs/decisions/…` and this test is what keeps the reading at zero.
 */
test("real repo: the broken-relative-link baseline is pinned at zero", () => {
	const files = uploadedFiles();
	const { checked, broken } = checkRelativeLinks({ root: REPO, files });
	assert.ok(
		checked.length >= 200,
		`只解析到 ${checked.length} 条相对链接，解析器本身可能坏了`,
	);
	assert.deepEqual(
		broken.map(({ path, target, raw }) => `${path} → ${target}（原文 ${raw}）`),
		[],
		"上传面出现断链：逐条修掉，或者说明为什么该引用是刻意的",
	);
});

test("real repo: the moved stage A+B report's links are re-based and resolve", () => {
	// This is the defect issue #37 was filed for. The file moved into
	// docs/handoff/ and its links were not re-based, so all 24 pointed at
	// non-existent `docs/packages/…` while the gate reported 0 violations.
	const path = "docs/handoff/qa-stage-ab-remediation-2026-09-25.md";
	const { checked, broken } = checkRelativeLinks({ root: REPO, files: [path] });
	assert.ok(checked.length >= 20, `只解析到 ${checked.length} 条`);
	assert.equal(broken.length, 0);
});
