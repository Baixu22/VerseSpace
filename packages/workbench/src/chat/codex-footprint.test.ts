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
