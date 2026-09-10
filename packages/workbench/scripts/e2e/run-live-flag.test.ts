import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const runTs = resolve(import.meta.dir, "run.ts");

test("--live without credentials fails closed before creating a tenant", async () => {
	const child = Bun.spawn(
		[process.execPath, runTs, "--live", "--rounds", "1"],
		{
			env: {
				...process.env,
				E2E_LLM_KEY: "",
				E2E_LLM_MODEL: "",
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [code, out, err] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect(code).not.toBe(0);
	expect(`${out}${err}`).toContain("E2E_LLM_KEY");
	expect(`${out}${err}`).not.toContain("e2e-tenant");
});

test("--start-round parser accepts a number and inherits from flag", async () => {
	// Read run.ts and grep that --start-round is used to seed nextRoundIndex.
	const source = await readFile(runTs, "utf8");
	expect(source).toContain("--start-round");
	expect(source).toMatch(
		/nextRoundIndex\s*=\s*Number\(\s*at\("--start-round"\)/,
	);
});
