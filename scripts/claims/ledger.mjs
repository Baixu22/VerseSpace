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

	const currentInstrument = hashOf(claim, instrumentHashes);
	if (currentInstrument === null) {
		return { id: claim.id, status: CLAIM_STATUS.missingInstrument };
	}

	// Shape first: a reading that does not carry the numbers the claim is about
	// cannot support it, however fresh it is.
	const shape = claim.reading_shape ?? {};
	for (const key of Object.keys(shape)) {
		if (!(key in (reading.reading ?? {}))) {
			return {
				id: claim.id,
				status: CLAIM_STATUS.badShape,
				detail: `缺 ${key}`,
			};
		}
	}

	if (reading.instrument_sha256 !== currentInstrument) {
		return { id: claim.id, status: CLAIM_STATUS.staleInstrument };
	}

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

	if (claim.class === "L3") {
		// Single observation: the instrument is gone, so this can never be
		// re-taken. It is recorded honestly as an observation and never counts as
		// evidence for a `done`.
		return { id: claim.id, status: CLAIM_STATUS.observation };
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
