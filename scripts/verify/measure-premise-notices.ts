import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

/**
 * Real-traffic premise-notice pipeline counter (TF-0274 / positive-yield ledger).
 *
 * Counts the read-side advisory-concurrency machinery as it actually fired in a
 * real Workbench ledger: stale premises detected, notices queued and delivered,
 * delivery observability mix, plus chat thread invalidation notices. This is the
 * "positive-yield" complement to the synthetic benchmark-premises.ts contract:
 * that one proves the detector contract; this one proves the pipeline ran in real
 * concurrent usage.
 *
 * It reads a ledger's events.jsonl + thread notices only. It does NOT assert any
 * correctness conclusion - the numbers are descriptive of one captured ledger.
 *
 * Usage:
 *   bun scripts/verify/measure-premise-notices.ts --json [--ledger <dir>]
 */
const REPO = resolve(import.meta.dir, "..", "..");

function countEvents(eventsPath) {
	const types = {};
	const outcomes = {};
	const deliveredObs = {};
	if (!existsSync(eventsPath))
		return { types, outcomes, deliveredObs, lines: 0 };
	const text = readFileSync(eventsPath, "utf8");
	const lines = text.split("\n").filter(Boolean);
	for (const line of lines) {
		let ev: unknown;
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
	}
	return { types, outcomes, deliveredObs, lines: lines.length };
}

function countThreadNotices(threadsDir) {
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
	const { types, outcomes, deliveredObs, lines } = countEvents(eventsPath);
	const thread = countThreadNotices(threadsDir);
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
