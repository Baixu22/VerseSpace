/**
 * Claim ↔ evidence evaluation. Pure: no fs, no child processes, no clock.
 *
 * The point of this module is the invalidation rule, and it is the same rule the
 * product applies to premises: **a reading is only as good as the state it was
 * taken in.** If the instrument changes, or the code the claim is about changes,
 * the reading is stale — not "probably still fine".
 *
 * Everything the caller has to know (current instrument hashes, what changed
 * since the reading's commit) is passed in, so this file is verifiable on a host
 * that forbids spawning processes (the agent sandbox is one; see ADR-0020's
 * reasoning for keeping `classify.mjs` pure).
 */

/** Statuses a claim can end up in. `valid` and `observation` are the only clean ones. */
export const CLAIM_STATUS = {
	valid: "valid",
	missingReading: "missing-reading",
	missingInstrument: "missing-instrument",
	staleInstrument: "stale-instrument",
	staleSubject: "stale-subject",
	badShape: "bad-shape",
	contradicted: "contradicted",
	observation: "observation",
};

/** A reading that cannot be re-taken (retired instrument) is an observation, not evidence. */
export function isClean(status) {
	return status === CLAIM_STATUS.valid || status === CLAIM_STATUS.observation;
}

function hashOf(claim, instrumentHashes) {
	const parts = [];
	for (const path of [...(claim.instrument ?? [])].sort()) {
		const hash = instrumentHashes[path];
		if (!hash) return null;
		parts.push(`${path}:${hash}`);
	}
	return parts.join("\n");
}

/**
 * The instrument identity the gate compares against. Exported so the recorder
 * (`scripts/claims/record-reading.mjs`) computes it the same way — two
 * implementations of this would drift, and a drifted hash is indistinguishable
 * from a stale reading.
 */
export function instrumentKey(claim, instrumentHashes) {
	return hashOf(claim, instrumentHashes);
}

/** Shared by the gate and recorder: freshness cannot rescue a false reading. */
export function readingProblem(claim, reading) {
	const bad = (detail) => ({ status: CLAIM_STATUS.badShape, detail });
	const contradicted = (detail) => ({
		status: CLAIM_STATUS.contradicted,
		detail,
	});
	if (typeof reading.subject_sha !== "string" || !reading.subject_sha.trim())
		return bad("缺 subject_sha");
	if (claim.class === "L3" && !claim.retired_reason?.trim())
		return bad("历史观测必须说明仪器或实验定义为何退役");
	const values = reading.reading;
	if (!values || typeof values !== "object" || Array.isArray(values))
		return bad("reading 必须是对象");
	for (const [key, type] of Object.entries(claim.reading_shape ?? {})) {
		if (
			!Object.hasOwn(values, key) ||
			typeof values[key] !== type ||
			(type === "number" && !Number.isFinite(values[key]))
		)
			return bad(`${key} 必须为 ${type}`);
	}
	if (!Number.isInteger(reading.instrument_exit))
		return bad("缺实际 instrument_exit");
	if (reading.instrument_exit !== 0 && claim.expects_nonzero_exit !== true)
		return contradicted(`仪器实际 exit=${reading.instrument_exit}`);
	if (
		typeof values.exit === "number" &&
		values.exit !== reading.instrument_exit
	)
		return contradicted(
			`读数 exit 与仪器实际 exit=${reading.instrument_exit} 不一致`,
		);
	for (const [key, expected] of Object.entries(claim.expected ?? {})) {
		if (values[key] !== expected)
			return contradicted(`${key} 不满足声明的值 ${JSON.stringify(expected)}`);
	}
	for (const [key, minimum] of Object.entries(claim.minimum ?? {})) {
		if (!Number.isFinite(values[key]) || values[key] < minimum)
			return contradicted(`${key} 必须 >= ${minimum}`);
	}
	return null;
}

/**
 * Evaluate one claim.
 *
 * @param claim  registry entry (id, instrument[], subject_paths[], reading_shape, class)
 * @param reading the deposited reading, or undefined
 * @param instrumentHashes map of instrument path → sha256 of its current content
 * @param changedSince paths that changed between the reading's commit and HEAD
 */
export function evaluateClaim(claim, reading, instrumentHashes, changedSince) {
	if (!reading) return { id: claim.id, status: CLAIM_STATUS.missingReading };

	const problem = readingProblem(claim, reading);
	if (problem) return { id: claim.id, ...problem };
	// A retired experiment stays attributable to its recorded revision; it never
	// certifies the current tree, even if its old instrument no longer exists.
	if (claim.class === "L3") {
		return {
			id: claim.id,
			status: CLAIM_STATUS.observation,
			detail: claim.retired_reason,
		};
	}
	const currentInstrument = hashOf(claim, instrumentHashes);
	if (currentInstrument === null)
		return { id: claim.id, status: CLAIM_STATUS.missingInstrument };
	if (reading.instrument_sha256 !== currentInstrument)
		return { id: claim.id, status: CLAIM_STATUS.staleInstrument };

	// `subject_paths` is what makes this precise: a docs-only commit must not
	// invalidate a test reading, and a one-line change inside the tested package
	// must.
	const subjectPaths = claim.subject_paths ?? [];
	const touched = (changedSince ?? []).filter((path) =>
		subjectPaths.some((glob) => matchesGlob(glob, path)),
	);
	if (touched.length > 0) {
		return {
			id: claim.id,
			status: CLAIM_STATUS.staleSubject,
			detail: `${touched.length} 个被测路径已变：${touched.slice(0, 3).join(", ")}`,
		};
	}

	return { id: claim.id, status: CLAIM_STATUS.valid };
}

/**
 * Minimal glob: a double-star followed by a slash spans zero or more segments,
 * `*` stays inside one segment, `?` is one character.
 *
 * (Written without the literal sequence in the doc comment — a double-star and a
 * slash together contain the comment terminator, which is how this line broke the
 * file once already.)
 */
export function matchesGlob(glob, path) {
	// A bare `**` means "any path at all". The loop below only recognises the
	// `**/` and `/**` forms, so `**` on its own compiled to `^[^/]*[^/]*$` —
	// which matches top-level files only. Measured 2026-09-26:
	// `claim-upload-surface-clean` declares `subject_paths: ["**"]` and stayed
	// `valid` while two docs changed. A claim that reads repo-wide but covers
	// one directory level is worse than no claim at all.
	if (glob === "**") return true;
	let out = "";
	for (let i = 0; i < glob.length; i++) {
		if (glob.startsWith("**/", i)) {
			// A leading double-star also matches zero segments — that is the common
			// case for patterns like `**/node_modules/**`.
			out += "(?:.*/)?";
			i += 2;
			continue;
		}
		if (glob.startsWith("/**", i)) {
			out += "(?:/.*)?";
			i += 2;
			continue;
		}
		const ch = glob[i];
		if (ch === "*") out += "[^/]*";
		else if (ch === "?") out += ".";
		else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${out}$`).test(path);
}

/**
 * Evaluate every registered claim. Returns the rows plus a verdict.
 *
 * `changedSinceBySha` maps a commit to the paths that changed since it, and each
 * claim is judged against **its own reading's commit**. Passing one merged list
 * for all claims over-invalidates: a reading taken today would be marked stale by
 * a change that happened before it was taken. (Measured 2026-09-26 — the first
 * version did exactly that.)
 */
export function evaluateClaims({
	claims,
	readings,
	instrumentHashes,
	changedSinceBySha,
}) {
	const byId = new Map((readings ?? []).map((r) => [r.claim_id, r]));
	const rows = (claims ?? []).map((claim) => {
		const reading = byId.get(claim.id);
		const changed = reading?.subject_sha
			? (changedSinceBySha?.[reading.subject_sha] ?? [])
			: [];
		return evaluateClaim(claim, reading, instrumentHashes ?? {}, changed);
	});
	const problems = rows.filter((row) => !isClean(row.status));
	return {
		rows,
		problems,
		valid: rows.filter((r) => r.status === CLAIM_STATUS.valid).length,
		observations: rows.filter((r) => r.status === CLAIM_STATUS.observation)
			.length,
		status: problems.length === 0 ? "clean" : "drift",
	};
}
