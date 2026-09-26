import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { approvalTargets } from "./approval-targets";

test("fileChange approval: the changed paths are the targets, and it is a write", () => {
	const target = approvalTargets("item/fileChange/requestApproval", {
		changes: [{ path: "src/target.ts" }],
	});
	expect(target.isApproval).toBe(true);
	expect(target.kind).toBe("write");
	expect(target.paths).toContain("src/target.ts");
});

test("commandExecution with a redirect is a write and names the target", () => {
	const target = approvalTargets("item/commandExecution/requestApproval", {
		command: "echo '// x' >> src/target.ts",
	});
	expect(target.kind).toBe("write");
	expect(target.paths).toContain("src/target.ts");
});

test("a read-only command is NOT reported as a write we sealed", () => {
	// If this returned `write` the ledger would claim a guard that never ran.
	const target = approvalTargets("item/commandExecution/requestApproval", {
		command: "cat src/target.ts",
	});
	expect(target.kind).toBe("unknown");
});

test("fileRead approval is a read, not a write", () => {
	const target = approvalTargets("item/fileRead/requestApproval", {
		path: "a.ts",
	});
	expect(target.kind).toBe("read");
});

test("a non-approval method is not an approval", () => {
	expect(approvalTargets("item/tool/requestUserInput", {}).isApproval).toBe(
		false,
	);
});

test("the REAL 0.158 fixture: the redirect target is found and it is a write", async () => {
	// This is the fixture ADR-0017 said did not exist. The first version of
	// approval-targets was written against a guessed shape; this pins it to what
	// codex 0.158 actually sends.
	const raw = await readFile(
		new URL(
			"../fixtures/approvals/command-execution-0.158.json",
			import.meta.url,
		),
		"utf8",
	);
	const fixture = JSON.parse(raw) as { method: string; params: unknown };
	const target = approvalTargets(fixture.method, fixture.params);
	expect(target.isApproval).toBe(true);
	expect(target.kind).toBe("write");
	expect(target.paths).toContain("src/target.ts");
});
