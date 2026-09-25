import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ChatThreads } from "../chat/threads";
import { makeTempWorkbench } from "../test/fixtures";
import { newReconcileStats, runReconcileTick } from "./reconcile-loop";
import { createUiServer } from "./server";

// TF-0260 (F-06): the background reconcile tick used
// `bb.config.load().catch(() => null)` and then kept draining — a corrupt
// workbench.yaml became indistinguishable from "no notification". Give the
// config-read failure its own identity: a counter, a last-error string, and a
// one-shot event, while still draining under an explicit default config so
// notices keep flowing.

function silenceErrors(): () => void {
	const original = console.error;
	console.error = () => {};
	return () => {
		console.error = original;
	};
}

test("config.load failure gets a distinct identity and still drains", async () => {
	const ws = await makeTempWorkbench();
	const chat = new ChatThreads(ws.bb);
	const restore = silenceErrors();
	try {
		ws.bb.config.load = async () => {
			throw new Error("boom: corrupt workbench.yaml");
		};
		const stats = newReconcileStats();
		await runReconcileTick(ws.bb, chat, stats);

		// the failure is visible: counted, last error captured
		expect(stats.configLoadFailures).toBe(1);
		expect(stats.lastConfigError).toContain("boom");
		// …and it is NOT smeared into the generic reconcile failure counter
		expect(stats.reconcileFailures).toBe(0);

		// a one-shot event records the corruption exactly once
		const failed = await ws.bb.events.query({ type: "config_load_failed" });
		expect(failed).toHaveLength(1);

		// draining still happened under the default config: the tick did not
		// abort, so the empty queue completes without throwing
		expect(stats.lastDrainOk).toBe(true);
	} finally {
		restore();
		await ws.cleanup();
	}
});

test("a repeated identical config error does not re-emit the event every tick", async () => {
	const ws = await makeTempWorkbench();
	const chat = new ChatThreads(ws.bb);
	const restore = silenceErrors();
	try {
		ws.bb.config.load = async () => {
			throw new Error("same corruption");
		};
		const stats = newReconcileStats();
		await runReconcileTick(ws.bb, chat, stats);
		await runReconcileTick(ws.bb, chat, stats);
		await runReconcileTick(ws.bb, chat, stats);

		// the counter keeps counting (three failed reads)…
		expect(stats.configLoadFailures).toBe(3);
		// …but the event log is not spammed: one entry per distinct error
		const failed = await ws.bb.events.query({ type: "config_load_failed" });
		expect(failed).toHaveLength(1);
	} finally {
		restore();
		await ws.cleanup();
	}
});

test("a healthy tick records no config failure and leaves no event", async () => {
	const ws = await makeTempWorkbench();
	const chat = new ChatThreads(ws.bb);
	try {
		const stats = newReconcileStats();
		await runReconcileTick(ws.bb, chat, stats);
		expect(stats.configLoadFailures).toBe(0);
		expect(stats.lastConfigError).toBeNull();
		expect(await ws.bb.events.query({ type: "config_load_failed" })).toEqual(
			[],
		);
	} finally {
		await ws.cleanup();
	}
});

/** A YAML flow mapping that never closes: the loader must refuse the file. */
const CORRUPT_YAML = "not: [valid";

interface StateResponse {
	config: unknown;
	configError: string | null;
	reconcile: { configLoadFailures: number; lastConfigError: string | null };
}

/** Poll /api/state until the background tick has recorded the config failure. */
async function pollState(
	server: Awaited<ReturnType<typeof createUiServer>>,
): Promise<StateResponse> {
	const deadline = Date.now() + 5_000;
	for (;;) {
		const response = await server.handle(
			new Request(`http://127.0.0.1:${server.port}/api/state`, {
				headers: { "x-workbench-token": server.authToken },
			}),
		);
		const state = (await response.json()) as StateResponse;
		if (state.reconcile.configLoadFailures > 0 || Date.now() > deadline) {
			return state;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

test("a genuinely corrupt workbench.yaml is visible, not silence", async () => {
	const ws = await makeTempWorkbench();
	const chat = new ChatThreads(ws.bb);
	const restore = silenceErrors();
	try {
		await writeFile(
			join(ws.workbenchRoot, "workbench.yaml"),
			CORRUPT_YAML,
			"utf8",
		);
		// the corruption is real: the loader refuses the file
		await expect(ws.bb.config.load()).rejects.toThrow();

		const stats = newReconcileStats();
		await runReconcileTick(ws.bb, chat, stats);

		// the failure has its own identity and is not smeared into the generic
		// reconcile counter…
		expect(stats.configLoadFailures).toBe(1);
		expect(stats.lastConfigError).toBeTruthy();
		expect(stats.reconcileFailures).toBe(0);
		// …it reaches the event log…
		expect(
			await ws.bb.events.query({ type: "config_load_failed" }),
		).toHaveLength(1);
		// …and the notice queue still drains under the explicit default budget,
		// so a corrupt config cannot silence premise notices
		expect(stats.lastDrainOk).toBe(true);
	} finally {
		restore();
		await ws.cleanup();
	}
});

test("server /api/state reports config unreadable apart from 'no notification'", async () => {
	const ws = await makeTempWorkbench();
	const restore = silenceErrors();
	const server = await createUiServer(ws.bb, 0, undefined, {
		reconcileIntervalMs: 25,
	});
	try {
		await writeFile(
			join(ws.workbenchRoot, "workbench.yaml"),
			CORRUPT_YAML,
			"utf8",
		);

		const state = await pollState(server);

		// a corrupt config is a reported identity on /api/state, not a bare 500
		// and not a silent zero — this is the surface an operator reads
		expect(state.config).toBeNull();
		expect(state.configError).toBeTruthy();
		expect(state.reconcile.configLoadFailures).toBeGreaterThan(0);
		expect(state.reconcile.lastConfigError).toBeTruthy();
	} finally {
		server.stop(true);
		// the interval is cleared, but a tick already in flight still holds the
		// workspace: let it land before the temp dir is removed
		await new Promise((resolve) => setTimeout(resolve, 100));
		restore();
		await ws.cleanup();
	}
});
