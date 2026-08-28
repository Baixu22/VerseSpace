import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendJsonlLine, writeFileAtomic } from "./atomic";

let dir: string;

beforeEach(async () => {
	dir = join(
		tmpdir(),
		`workbench-atomic-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	await mkdir(dir, { recursive: true });
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("writeFileAtomic", () => {
	test("creates a new file", async () => {
		const target = join(dir, "goal.yaml");
		await writeFileAtomic(target, "id: g-1\n");
		expect(await readFile(target, "utf8")).toBe("id: g-1\n");
	});

	test("atomically replaces existing content", async () => {
		const target = join(dir, "goal.yaml");
		await writeFileAtomic(target, "v: 1\n");
		await writeFileAtomic(target, "v: 2\n");
		expect(await readFile(target, "utf8")).toBe("v: 2\n");
	});

	test("leaves no temp files behind", async () => {
		const target = join(dir, "a.yaml");
		await writeFileAtomic(target, "x: 1\n");
		await writeFileAtomic(target, "x: 2\n");
		const leftovers = (await readdir(dir)).filter((name) =>
			name.endsWith(".tmp"),
		);
		expect(leftovers).toEqual([]);
	});

	test("creates missing parent directories", async () => {
		const target = join(dir, "nested", "deep", "file.yaml");
		await writeFileAtomic(target, "ok: true\n");
		expect(await readFile(target, "utf8")).toBe("ok: true\n");
	});
});

describe("appendJsonlLine", () => {
	test("appends one JSON object per line", async () => {
		const target = join(dir, "events.jsonl");
		await writeFile(target, "", "utf8");
		await appendJsonlLine(target, { type: "a", n: 1 });
		await appendJsonlLine(target, { type: "b", n: 2 });
		const lines = (await readFile(target, "utf8")).trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0] ?? "{}")).toEqual({ type: "a", n: 1 });
		expect(JSON.parse(lines[1] ?? "{}")).toEqual({ type: "b", n: 2 });
	});
});
