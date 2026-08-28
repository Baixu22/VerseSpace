import { describe, expect, test } from "bun:test";
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hashFile } from "../hash";
import { makeTempWorkbench } from "../test/fixtures";

const CONTRACT = "contract-file.md";

async function seedContract(
	projectDir: string,
	content: string,
): Promise<string> {
	const file = join(projectDir, CONTRACT);
	await writeFile(file, content, "utf8");
	return file;
}

function entryFor(hash: string) {
	return {
		key: "core/api",
		canonicalPath: CONTRACT,
		version: 1,
		publishedBy: "ws-alpha",
		lastModified: new Date().toISOString(),
		contentHash: hash,
		subscribers: [{ workspot: "ws-beta", reason: "消费该接口" }],
	};
}

describe("interfaces blackboard API", () => {
	test("register / getEntry / getSubscribers roundtrip", async () => {
		const { bb, projectDir, cleanup } = await makeTempWorkbench();
		try {
			const file = await seedContract(projectDir, "# api v1\n");
			const entry = entryFor(await hashFile(file));

			await bb.interfaces.register(entry);
			const loaded = await bb.interfaces.getEntry("core/api");
			expect(loaded?.version).toBe(1);
			expect(loaded?.subscribers).toHaveLength(1);
			expect(await bb.interfaces.getSubscribers("core/api")).toEqual(
				entry.subscribers,
			);
			expect(await bb.interfaces.getSubscribers("missing")).toEqual([]);
		} finally {
			await cleanup();
		}
	});

	test("register replaces an entry with the same key", async () => {
		const { bb, projectDir, cleanup } = await makeTempWorkbench();
		try {
			const file = await seedContract(projectDir, "# api v1\n");
			const entry = entryFor(await hashFile(file));
			await bb.interfaces.register(entry);
			await bb.interfaces.register({ ...entry, version: 2 });
			const listed = await bb.interfaces.list();
			expect(listed).toHaveLength(1);
			expect(listed[0]?.version).toBe(2);
		} finally {
			await cleanup();
		}
	});

	test("checkDrift detects content change and updateVersion re-anchors", async () => {
		const { bb, projectDir, cleanup } = await makeTempWorkbench();
		try {
			const file = await seedContract(projectDir, "# api v1\n");
			await bb.interfaces.register(entryFor(await hashFile(file)));

			let report = await bb.interfaces.checkDrift("core/api");
			expect(report.drifted).toBe(false);

			await appendFile(file, "\n# breaking change\n", "utf8");
			report = await bb.interfaces.checkDrift("core/api");
			expect(report.drifted).toBe(true);
			expect(report.currentHash).not.toBe(report.registeredHash);

			const updated = await bb.interfaces.updateVersion(
				"core/api",
				report.currentHash as string,
			);
			expect(updated.version).toBe(2);
			expect((await bb.interfaces.checkDrift("core/api")).drifted).toBe(false);
		} finally {
			await cleanup();
		}
	});

	test("checkDrift flags a missing interface file", async () => {
		const { bb, cleanup } = await makeTempWorkbench();
		try {
			await bb.interfaces.register(entryFor("deadbeef"));
			const report = await bb.interfaces.checkDrift("core/api");
			expect(report.drifted).toBe(true);
			expect(report.missing).toBe(true);
			expect(report.currentHash).toBeNull();
		} finally {
			await cleanup();
		}
	});
});
