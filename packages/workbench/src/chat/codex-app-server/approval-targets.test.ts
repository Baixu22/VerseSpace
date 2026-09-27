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

test("the REAL 0.158 fixture: the command's cwd is not a write target", async () => {
	// 2026-09-27: the real params carry `cwd` next to `command`, and PATH_FIELDS
	// used to collect it. That made the write approval look like it touched two
	// paths, and `session.ts` sealed the project root — which
	// `normalizeTarget(root, root)` records as `path: ""`. The route is
	// reproducible: the read-only codex run's write turn left exactly
	// `[{path:"",decision:"pass"}, {path:"src/target.ts",decision:"pass"}]`
	// (raw rollout under .agent-contexts/codex-seal-ro/, see
	// docs/handoff/2026-09-27-claim-hygiene-round.md).
	const raw = await readFile(
		new URL(
			"../fixtures/approvals/command-execution-0.158.json",
			import.meta.url,
		),
		"utf8",
	);
	const fixture = JSON.parse(raw) as {
		method: string;
		params: { cwd?: string };
	};
	expect(typeof fixture.params.cwd).toBe("string");
	const target = approvalTargets(fixture.method, fixture.params);
	// One path, and it is the file the command writes to — not the directory the
	// command runs in.
	expect(target.paths).toEqual(["src/target.ts"]);
	expect(target.paths).not.toContain(fixture.params.cwd);
});

test("a fileChange approval is attributable ONLY through the correlated item paths", () => {
	// The shape codex 0.158 really sends: no path anywhere in the params.
	const params = {
		threadId: "01a0e183-47c0-7213-a060-580556356621",
		turnId: "01a0e183-4828-74c2-bba0-fdbf6aa4288a",
		itemId: "call_49ea214b036846fcafa94549",
		startedAtMs: 1790489897299,
		reason: null,
		grantRoot: null,
	};
	// Pre-correlation: kind is already `write` (method-based), but nothing is
	// attributable — so the session's seal gate (`kind === "write" &&
	// paths.length > 0`) cannot fire. This is the bug the correlation fixes.
	const uncorrelated = approvalTargets(
		"item/fileChange/requestApproval",
		params,
	);
	expect(uncorrelated.kind).toBe("write");
	expect(uncorrelated.paths).toEqual([]);

	const target = approvalTargets("item/fileChange/requestApproval", params, [
		"src/notes.md",
	]);
	expect(target.kind).toBe("write");
	expect(target.paths).toEqual(["src/notes.md"]);
	expect(target.kind === "write" && target.paths.length > 0).toBe(true);
});

test("correlated item paths do NOT make a command approval a write", () => {
	// ADR-0023 evidence unchanged: a commandExecution approval's itemId names a
	// command item, never a fileChange item. Passing stray paths must not
	// manufacture a write out of a command codex could not classify.
	const target = approvalTargets(
		"item/commandExecution/requestApproval",
		{ commandActions: [{ type: "unknown", command: "npm test" }] },
		["src/target.ts"],
	);
	expect(target.kind).toBe("unknown");
	expect(target.paths).toEqual([]);
});

test("the REAL file-change fixture: request has no path, item does, itemId joins them", async () => {
	const raw = await readFile(
		new URL("../fixtures/approvals/file-change-0.158.json", import.meta.url),
		"utf8",
	);
	const fixture = JSON.parse(raw) as {
		turns: Array<{
			items: Array<{ params: { item: Record<string, unknown> } }>;
			requests: Array<{
				method: string;
				params: Record<string, unknown>;
			}>;
		}>;
	};
	expect(fixture.turns).toHaveLength(2);
	for (const turn of fixture.turns) {
		const request = turn.requests[0];
		const item = turn.items[0]?.params.item;
		const changes = item?.changes as Array<{ path: string }>;
		const path = changes[0]?.path;
		if (!request || !path) throw new Error("fixture 少了 request 或 path");

		expect(request.method).toBe("item/fileChange/requestApproval");
		// The pin: the approval params carry no path field at all.
		expect(JSON.stringify(request.params)).not.toContain("path");
		expect(request.params.grantRoot).toBeNull();
		expect(item?.id).toBe(request.params.itemId);
		expect(typeof path).toBe("string");

		expect(
			approvalTargets(request.method, request.params, [path]).paths,
		).toEqual([path]);
	}
});
