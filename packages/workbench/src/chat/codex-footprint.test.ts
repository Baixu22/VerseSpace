import { expect, test } from "bun:test";
import { extractCodexFootprint } from "./codex-footprint";

test("unstructured shell reads have an explicit compatibility boundary", () => {
	const item = (command: string) => ({
		type: "commandExecution",
		id: "probe",
		command,
		commandActions: [{ type: "unknown", command }],
	});
	expect(
		extractCodexFootprint(item("Get-Content src/target.ts"), "lane"),
	).toBeNull();
	expect(
		extractCodexFootprint(item("cat src/target.ts"), "lane")?.used.map(
			(r) => r.path,
		),
	).toEqual(["src/target.ts"]);
	expect(
		extractCodexFootprint(
			{
				...item("Get-Content src/target.ts"),
				commandActions: [{ type: "read", path: "src/target.ts" }],
			},
			"lane",
		)?.used,
	).toHaveLength(1);
});

test("shell-wrapper quote tails never become part of the path claim", () => {
	// Real 2026-09-27 capture: pwsh-launched cat arrived as `cat src/target.ts"'`
	// and the claim was `src/target.ts"'`, which never matched the seal target.
	const item = (command: string) => ({
		type: "commandExecution",
		id: "probe",
		command,
		commandActions: [{ type: "unknown", command }],
	});
	expect(
		extractCodexFootprint(
			item(`"pwsh.cmd" -NoProfile -Command "cat src/target.ts"'`),
			"lane",
		)?.used.map((r) => r.path),
	).toEqual(["src/target.ts"]);
	expect(
		extractCodexFootprint(item(`cat 'src/target.ts'`), "lane")?.used.map(
			(r) => r.path,
		),
	).toEqual(["src/target.ts"]);
});
