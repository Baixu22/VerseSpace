import { expect, test } from "bun:test";
import { resolveSpawnCommand } from "./argv";
import { spawnSupervised } from "./index";

test("an absolute command that is gone resolves to null, not a raw spawn ENOENT", async () => {
	// Windows-only branch. A stale configured command (measured 2026-09-26: the
	// Codex desktop app rotates its runtime directory, so a hardcoded
	// WORKBENCH_CODEX_COMMAND went stale mid-session) used to be returned as-is
	// and blow up as `ENOENT: uv_spawn 'C:/…/codex.exe'` — a path with no
	// explanation. It must instead fail the same way a missing bare name does.
	if (process.platform !== "win32") return;
	expect(
		await resolveSpawnCommand(["C:\\definitely\\missing\\nope.exe"]),
	).toBeNull();
	// A real absolute path still resolves.
	expect(await resolveSpawnCommand([process.execPath])).not.toBeNull();
});

test("argv input preserves spaces, quotes and multiline prompts", async () => {
	const args = [
		"two words",
		'quote " stays',
		"first\nsecond",
		"literal $(command)",
	];
	const lines: string[] = [];
	const proc = spawnSupervised(
		[
			process.execPath,
			"-e",
			"console.log(JSON.stringify(process.argv.slice(1)))",
			...args,
		],
		{
			label: "argv-regression",
			timeoutSeconds: 5,
			onLine: (line, kind) => {
				if (kind === "out") lines.push(line);
			},
		},
	);
	expect((await proc.wait()).exitCode).toBe(0);
	expect(JSON.parse(lines.join("\n"))).toEqual(args);
});
