import { expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempWorkbench } from "../test/fixtures";
import { isProcessAlive, spawnSupervised } from "./index";

test("cancel before the stdin gate abandons the deferred fallback", async () => {
	const ws = await makeTempWorkbench();
	const file = join(ws.projectDir, "sleep.js");
	await writeFile(file, 'console.log("ready"); setInterval(() => {}, 1000);\n');
	const originalSpawn = childProcess.spawn;
	let inputCalls = () => 0;
	let restoreInput = () => {};
	const capture = spyOn(childProcess, "spawn").mockImplementation(((
		...args: Parameters<typeof childProcess.spawn>
	) => {
		const child = originalSpawn(...args);
		if (args[1].includes(file) && child.stdin) {
			const input = spyOn(child.stdin, "write");
			inputCalls = () => input.mock.calls.length;
			restoreInput = () => input.mockRestore();
		}
		return child;
	}) as typeof childProcess.spawn);
	let ready: () => void = () => {};
	const started = new Promise<void>((resolve) => {
		ready = resolve;
	});
	const proc = spawnSupervised([process.execPath, file], {
		label: "stdin-cancel",
		stdin: "initial prompt\n",
		keepStdinOpen: true,
		stdinGate: () => false,
		stdinFallbackMs: 1000,
		onLine: (line) => {
			if (line === "ready") ready();
		},
	});
	try {
		await started;
		const stopping = proc.kill();
		expect(() => proc.writeStdin("late input\n")).toThrow("stdin 不可写");
		await stopping;
		expect((await proc.wait()).killed).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 1100));
		expect(isProcessAlive(proc.pid ?? -1)).toBe(false);
		expect(inputCalls()).toBe(0);
	} finally {
		capture.mockRestore();
		restoreInput();
		await proc.kill();
		await proc.wait();
		await ws.cleanup();
	}
});
