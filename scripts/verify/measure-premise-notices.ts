import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

/**
 * Real-traffic premise-notice pipeline counter (TF-0274 / positive-yield ledger).
 *
 * Counts the read-side advisory-concurrency machinery as it actually fired in a
 * real Workbench ledger. Two surfaces:
 *
 *  1. the notification pipeline (stale detected / queued / delivered / observability);
 *  2. the base-rate amplifier (ADR-0006 sec.2): every premise_pass records the raw
 *     candidate overlaps and how many were suppressed by dedup and the L1 noise tier
 *     before a notice survived to delivery. This is the concrete embodiment of the
 *     PPV argument: a brute-force detector would surface every overlap; the read-set
 *     overlap filter + dedup collapse them to the handful that were actually notified.
 *
 * It reads a ledger's events.jsonl + thread notices only. It asserts no correctness
 * conclusion - the numbers are descriptive of one captured ledger.
 *
 * Usage:
 *   bun scripts/verify/measure-premise-notices.ts --json [--ledger <dir>]
 */
const REPO = resolve(import.meta.dir, "..", "..");

interface PassPayload {
	overlaps?: number;
	suppressedL1?: number;
	suppressedL2?: number;
	suppressedL3?: number;
	suppressedDedup?: number;
	notified?: number;
	writers?: number;
}

function countEvents(eventsPath: string) {
	const types: Record<string, number> = {};
	const outcomes: Record<string, number> = {};
	const deliveredObs: Record<string, number> = {};
	const pass = {
		events: 0,
		overlaps: 0,
		suppressedL1: 0,
		suppressedL3: 0,
		suppressedDedup: 0,
		notified: 0,
		writers: 0,
	};
	if (!existsSync(eventsPath))
		return { types, outcomes, deliveredObs, pass, lines: 0 };
	const text = readFileSync(eventsPath, "utf8");
	const lines = text.split("\n").filter(Boolean);
	for (const line of lines) {
		let ev: any;
		try {
			ev = JSON.parse(line);
		} catch {
			continue;
		}
		const t = ev?.type;
		if (!t) continue;
		types[t] = (types[t] ?? 0) + 1;
		if (t === "premise_notice_outcome") {
			const o = ev?.payload?.outcome;
			if (o) outcomes[o] = (outcomes[o] ?? 0) + 1;
		}
		if (t === "premise_notice_delivered") {
			const obs = ev?.payload?.readObservability;
			if (obs) deliveredObs[obs] = (deliveredObs[obs] ?? 0) + 1;
		}
		if (t === "premise_pass") {
			const p = (ev?.payload ?? {}) as PassPayload;
			pass.events += 1;
			pass.overlaps += p.overlaps ?? 0;
			pass.suppressedL1 += p.suppressedL1 ?? 0;
			pass.suppressedL3 += p.suppressedL3 ?? 0;
			pass.suppressedDedup += p.suppressedDedup ?? 0;
			pass.notified += p.notified ?? 0;
			pass.writers += p.writers ?? 0;
		}
	}
	return { types, outcomes, deliveredObs, pass, lines: lines.length };
}

function countThreadNotices(threadsDir: string) {
	if (!existsSync(threadsDir))
		return { threads: 0, notices: 0, invalidation: 0 };
	let threads = 0,
		notices = 0,
		invalidation = 0;
	const dirs = readdirSync(threadsDir, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name);
	for (const dir of dirs) {
		const nf = join(threadsDir, dir, "notices.jsonl");
		if (!existsSync(nf)) continue;
		threads += 1;
		const text = readFileSync(nf, "utf8");
		for (const line of text.split("\n").filter(Boolean)) {
			notices += 1;
			if (line.includes("前提失效")) invalidation += 1;
		}
	}
	return { threads, notices, invalidation };
}

function countFootprintWriters(eventsPath: string): number {
	if (!existsSync(eventsPath)) return 0;
	const seen = new Set<string>();
	const text = readFileSync(eventsPath, "utf8");
	for (const line of text.split("\n").filter(Boolean)) {
		try {
			const ev = JSON.parse(line);
			if (ev?.type === "footprint" && ev?.payload?.writer)
				seen.add(ev.payload.writer);
		} catch {}
	}
	return seen.size;
}

function main() {
	const { values } = parseArgs({
		args: process.argv.slice(2),
		options: {
			json: { type: "boolean", default: false },
			ledger: { type: "string" },
		},
	});
	const ledgerDir = values.ledger
		? resolve(values.ledger)
		: join(REPO, ".workbench");
	const eventsPath = join(ledgerDir, "events", "events.jsonl");
	const threadsDir = join(ledgerDir, "threads");
	const { types, outcomes, deliveredObs, pass, lines } =
		countEvents(eventsPath);
	const thread = countThreadNotices(threadsDir);
	const footprintWriters = countFootprintWriters(eventsPath);
	const reading = {
		ledgerDir,
		eventLines: lines,
		premiseStale: types["premise_stale"] ?? 0,
		premiseNoticeQueued: types["premise_notice_queued"] ?? 0,
		premiseNoticeDelivered: types["premise_notice_delivered"] ?? 0,
		premiseNoticeOutcome: types["premise_notice_outcome"] ?? 0,
		outcomeQueued: outcomes["queued"] ?? 0,
		deliveredFootprint: deliveredObs["footprint"] ?? 0,
		deliveredUnobservable: deliveredObs["unobservable"] ?? 0,
		threadNotices: thread.notices,
		threadInvalidationNotices: thread.invalidation,
		threadsWithNotices: thread.threads,
		footprintWriters,
		premisePassEvents: pass.events,
		premisePassOverlaps: pass.overlaps,
		premisePassSuppressedDedup: pass.suppressedDedup,
		premisePassSuppressedL1: pass.suppressedL1,
		premisePassSuppressedL3: pass.suppressedL3,
		premisePassNotified: pass.notified,
		premisePassWriters: pass.writers,
	};
	if (values.json) {
		process.stdout.write(JSON.stringify(reading, null, 2) + "\n");
	} else {
		for (const [k, v] of Object.entries(reading)) {
			if (k === "ledgerDir") continue;
			process.stdout.write(`${k}: ${v}\n`);
		}
	}
	process.exit(0);
}

main();
