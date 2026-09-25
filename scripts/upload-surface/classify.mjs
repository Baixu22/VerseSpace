/**
 * Upload-surface classifier — the pure half of the relay-handoff gate.
 *
 * WHY THIS FILE HAS NO `child_process` IMPORT
 * -------------------------------------------
 * The classification is a pure function of three path lists plus a policy. It
 * does not run git, touch the network, or read the filesystem. That is
 * deliberate, for two reasons:
 *
 * 1. **It is the part that must be provable.** A gate whose verdict depends on
 *    spawning a process cannot be unit-tested on a host that denies
 *    `spawn` — and the DSH agent sandbox on this machine does exactly that
 *    (`spawnSync git EPERM`, see AGENTS.md). Keeping the decision pure means
 *    the decision is testable everywhere, including here.
 * 2. **The git probe is a separate, inspectable step.** `check-upload-surface.mjs`
 *    collects the lists and hands them over. When a host cannot spawn git from
 *    node, the lists can be collected by any other means (`--lists <dir>`) and
 *    the verdict is still computed by this same code — no second
 *    implementation to drift.
 *
 * The policy is a 4-class "定性" of development content: each path resolves to
 * exactly one class, and each class declares whether it is uploaded. Two
 * invariants then run in both directions — see `evaluate()`.
 */

/** Strip a leading `./` and any trailing slashes; normalise `\` to `/`. */
export function normalizePath(path) {
	return String(path)
		.replace(/\\/g, "/")
		.replace(/^\.\//, "")
		.replace(/\/+$/, "");
}

/** Escape one glob segment's regex metacharacters, then re-open `*` and `?`. */
function segmentToRegExpSource(segment) {
	let out = "";
	for (const char of segment) {
		if (char === "*") {
			out += "[^/]*";
		} else if (char === "?") {
			out += "[^/]";
		} else {
			out += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		}
	}
	return out;
}

/**
 * Compile a glob to an anchored RegExp over a repo-relative path.
 *
 * Supported: `*` (within a segment), `?` (one char), `**` (a whole segment =
 * zero or more segments), and a trailing `/` meaning "everything below".
 * A trailing slash is expanded to `/**`, so `docs/handoff/` and
 * `docs/handoff/**` are the same pattern.
 */
export function globToRegExp(glob) {
	// A trailing slash means "this directory and everything below it". It must
	// be expanded BEFORE trailing slashes are stripped, otherwise `docs/x/`
	// would compile to `^docs/x$` and silently match nothing inside the tree.
	const raw = String(glob).replace(/\\/g, "/").replace(/^\.\//, "");
	const normalized = raw.endsWith("/") ? `${raw}**` : raw.replace(/\/+$/, "");
	const segments = normalized.split("/");
	let source = "^";
	for (let index = 0; index < segments.length; index += 1) {
		const segment = segments[index];
		const isLast = index === segments.length - 1;
		if (segment === "**") {
			// `**` as a full segment: zero or more path segments.
			source += isLast ? ".*" : "(?:[^/]+/)*";
		} else {
			source += segmentToRegExpSource(segment);
			if (!isLast) {
				source += "/";
			}
		}
	}
	return new RegExp(`${source}$`);
}

/** Pre-compile a policy's rules once, so a 200k-path sweep stays linear-ish. */
export function compilePolicy(policy) {
	return {
		...policy,
		compiled: (policy.rules ?? []).map((rule, index) => ({
			index,
			label: rule.why ?? `rule#${index}`,
			class: rule.class,
			globs: rule.globs,
			patterns: rule.globs.map(globToRegExp),
		})),
	};
}

/**
 * Resolve one path to its class. FIRST MATCH WINS, so a policy must list its
 * most specific rules first and let broad rules follow. `defaultClass` is the
 * floor — it is reported as `unclassified`, never as a silent pass.
 */
export function classifyPath(compiled, path) {
	const target = normalizePath(path);
	for (const rule of compiled.compiled) {
		for (const pattern of rule.patterns) {
			if (pattern.test(target)) {
				return {
					path: target,
					class: rule.class,
					ruleIndex: rule.index,
					rule: rule.label,
				};
			}
		}
	}
	return {
		path: target,
		class: compiled.defaultClass,
		ruleIndex: -1,
		rule: "policy.defaultClass",
	};
}

/** The class record for a verdict, with `upload` defaulting to false. */
function classRecord(policy, className) {
	return policy.classes?.[className] ?? { upload: false, reason: "未知类别" };
}

/**
 * Run both directions of the invariant over a collected surface.
 *
 * `uploaded` = tracked ∪ untracked-not-ignored (what `git add -A` would ship).
 * `ignored`  = present on disk, excluded by .gitignore (what stays local).
 *
 * Violation codes:
 *   useful-not-uploaded — a local-only path whose class says it must ship.
 *                         This is the "有用未传" direction.
 *   useless-uploaded    — a shipped path whose class says it must stay local.
 *                         This is the "无用已传" direction.
 *   unclassified        — the policy has no rule for the path, so nobody has
 *                         decided. Silence is not a decision.
 *   oversize-uploaded   — a shipped file above `sizeLimitBytes` and not named
 *                         in `sizeExceptions`.
 */
export function evaluate({ policy, uploaded = [], ignored = [], sizes = {} }) {
	const compiled = compilePolicy(policy);
	const violations = [];
	const byClass = {};
	const limit = policy.sizeLimitBytes ?? Number.POSITIVE_INFINITY;
	const exceptions = (policy.sizeExceptions ?? []).map(globToRegExp);

	const tally = (className) => {
		byClass[className] = (byClass[className] ?? 0) + 1;
	};

	for (const path of ignored) {
		const verdict = classifyPath(compiled, path);
		tally(verdict.class);
		if (verdict.class === compiled.defaultClass) {
			violations.push({
				code: "unclassified",
				side: "local-only",
				path: verdict.path,
				class: verdict.class,
				detail: "本机遗留且策略未定性：要么上传，要么显式归入某个本机类别",
			});
			continue;
		}
		const record = classRecord(policy, verdict.class);
		if (record.upload === true) {
			violations.push({
				code: "useful-not-uploaded",
				side: "local-only",
				path: verdict.path,
				class: verdict.class,
				detail: `类别 ${verdict.class} 要求上传，但该路径被 .gitignore 排除（${verdict.rule}）`,
			});
		}
	}

	for (const path of uploaded) {
		const verdict = classifyPath(compiled, path);
		tally(verdict.class);
		if (verdict.class === compiled.defaultClass) {
			violations.push({
				code: "unclassified",
				side: "uploaded",
				path: verdict.path,
				class: verdict.class,
				detail: "在上传面内但策略未定性",
			});
			continue;
		}
		const record = classRecord(policy, verdict.class);
		if (record.upload !== true) {
			violations.push({
				code: "useless-uploaded",
				side: "uploaded",
				path: verdict.path,
				class: verdict.class,
				detail: `类别 ${verdict.class} 要求留本机，但该路径在上传面内（${verdict.rule}）`,
			});
		}
		const bytes = sizes[verdict.path];
		if (
			typeof bytes === "number" &&
			bytes > limit &&
			!exceptions.some((pattern) => pattern.test(verdict.path))
		) {
			violations.push({
				code: "oversize-uploaded",
				side: "uploaded",
				path: verdict.path,
				class: verdict.class,
				detail: `${bytes} 字节超过上限 ${limit}；如确需上传，请加入 sizeExceptions 并说明理由`,
			});
		}
	}

	return {
		status: violations.length > 0 ? "violations" : "clean",
		policyVersion: policy.version,
		defaultClass: compiled.defaultClass,
		counts: {
			uploaded: uploaded.length,
			ignored: ignored.length,
			byClass,
			violations: violations.length,
		},
		violations,
	};
}

/** Group violations by code, for a compact human-readable report. */
export function summarize(violations) {
	const groups = new Map();
	for (const violation of violations) {
		if (!groups.has(violation.code)) {
			groups.set(violation.code, []);
		}
		groups.get(violation.code).push(violation);
	}
	return groups;
}
