/** Synthetic local JSONL cost probe. No model calls or production logs. */
import assert from "node:assert/strict";
import { appendFile, readFile, stat, writeFile } from "node:fs/promises";
import { cpus, freemem, totalmem } from "node:os";
import { join } from "node:path";
import { type Blackboard, openBlackboard } from "../src/blackboard";
import { hashText } from "../src/hash";
import {
	currentPremiseNotices,
	reconcilePremises,
} from "../src/runtime/premises";
import { diffReadSet } from "../src/runtime/read-set-diff";
import { decideSeal } from "../src/runtime/seal";
import { makeTempWorkbench } from "../src/test/fixtures";

const repetitions = 7;
const measurements: unknown[] = [];
function distribution(values: number[]) {
	const sorted = [...values].sort((a, b) => a - b);
	return {
		min: sorted[0],
		median: sorted[Math.floor(sorted.length / 2)],
		p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
		max: sorted.at(-1),
	};
}

for (const [rows, fragments] of [
	[1_000, 8],
	[10_000, 64],
	[50_000, 256],
] as const) {
	const ws = await makeTempWorkbench();
	try {
		await ws.bb.sessions.register("reader", "agent");
		await writeFile(
			join(ws.projectDir, "source.txt"),
			"changed\n".repeat(fragments),
		);
		const footprintFile = join(
			ws.bb.paths.sessions,
			"reader",
			"footprint.jsonl",
		);
		const footprints = Array.from({ length: rows }, (_, i) => ({
			timestamp: "2026-10-01T00:00:00Z",
			activity: `read-${i}`,
			agent: "reader",
			used: [
				{
					path: "source.txt",
					version: hashText(`version-${i % 4}`),
					span: { start: (i % fragments) + 1, end: (i % fragments) + 1 },
				},
			],
			generated: [],
			facets: { tool: "Read" },
		}));
		await writeFile(
			footprintFile,
			`${footprints.map((line) => JSON.stringify(line)).join("\n")}\n`,
		);
		await writeFile(
			ws.bb.paths.eventsFile,
			`${footprints
				.map((line, i) =>
					JSON.stringify({
						id: `e-${i}`,
						eventSeq: i + 1,
						timestamp: line.timestamp,
						source: "sessions",
						type: "footprint",
						payload: { writer: "reader", ...line },
					}),
				)
				.join("\n")}\n`,
		);
		const bytes = {
			footprint: (await stat(footprintFile)).size,
			events: (await stat(ws.bb.paths.eventsFile)).size,
		};
		const operations: Record<string, (bb: Blackboard) => Promise<unknown>> = {
			current: (bb) => currentPremiseNotices(bb, "reader"),
			reconcile: (bb) => reconcilePremises(bb),
			seal: (bb) =>
				decideSeal(bb, {
					writerId: "reader",
					target: "source.txt",
					mode: "warn",
				}),
			restore: (bb) =>
				diffReadSet(bb, "reader", {
					footprintSeq: rows,
					eventSeq: rows,
					eventId: `e-${rows - 1}`,
				}),
		};
		for (const [name, operation] of Object.entries(operations)) {
			const times: number[] = [],
				heaps: number[] = [],
				rss: number[] = [],
				volumes: number[] = [];
			const bb = openBlackboard(ws.workbenchRoot);
			let logicalBytes = 0;
			for (const key of ["all", "query", "tail"] as const) {
				const original = bb.events[key].bind(bb.events);
				Object.assign(bb.events, {
					[key]: async (...args: never[]) => {
						const size = (await stat(bb.paths.eventsFile)).size;
						logicalBytes += size;
						return (original as (...args: never[]) => Promise<unknown>)(
							...args,
						);
					},
				});
			}
			for (const key of ["footprint", "readSetView"] as const) {
				const original = bb.sessions[key].bind(bb.sessions);
				Object.assign(bb.sessions, {
					[key]: async (...args: never[]) => {
						const size = (await stat(footprintFile)).size;
						logicalBytes += size;
						return (original as (...args: never[]) => Promise<unknown>)(
							...args,
						);
					},
				});
			}
			for (let i = 0; i < repetitions + 1; i++) {
				Bun.gc(true);
				const before = process.memoryUsage().heapUsed;
				logicalBytes = 0;
				const start = performance.now();
				await operation(bb);
				times.push(performance.now() - start);
				heaps.push(process.memoryUsage().heapUsed - before);
				rss.push(process.memoryUsage().rss);
				volumes.push(logicalBytes);
			}
			measurements.push({
				rows,
				fragments,
				bytes,
				operation: name,
				coldApplicationMs: times[0],
				warmMs: distribution(times.slice(1)),
				heapDeltaBytes: distribution(heaps),
				observedRssBytes: Math.max(...rss),
				logicalJsonlBytes: distribution(volumes),
			});
		}
		// A torn line must not erase any earlier observation, in a reopened reader.
		const before = await ws.bb.sessions.readSetView("reader");
		const eventsBefore = await ws.bb.events.all();
		await appendFile(footprintFile, '{"activity":"torn');
		await appendFile(ws.bb.paths.eventsFile, '{"type":');
		const reopened = openBlackboard(ws.workbenchRoot);
		assert.deepEqual(await reopened.sessions.readSetView("reader"), before);
		assert.equal((await reopened.events.all()).length, eventsBefore.length);
		assert.equal((await currentPremiseNotices(reopened, "reader")).length, 1);
		assert.ok(
			(await readFile(footprintFile, "utf8")).endsWith('{"activity":"torn'),
		);
	} finally {
		await ws.cleanup();
	}
}
console.log(
	JSON.stringify(
		{
			platform: process.platform,
			arch: process.arch,
			bun: Bun.version,
			cpu: cpus()[0]?.model,
			logicalCpus: cpus().length,
			totalMemoryBytes: totalmem(),
			freeMemoryBytes: freemem(),
			repetitions,
			notes:
				"Cold means first call on reopened Blackboard, not flushed OS disk cache. Logical JSONL byte counters add stat overhead; physical disk IO and transient peak memory are not measured. Reconcile includes duplicate suppression and appends; sealed writes are not performed. Torn-line checks passed at all scales.",
			measurements,
		},
		null,
		2,
	),
);
