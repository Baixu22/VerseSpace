import { expect, test } from "bun:test";
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
