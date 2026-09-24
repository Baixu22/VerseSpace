import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BlackboardDataError } from "../errors";
import { makeTempWorkbench } from "../test/fixtures";
import { ThreadRepository } from "./thread-repository";

/**
 * "You have no conversations" and "I could not look" used to be the same value
 * (`[]`), so an unreadable `threads/` directory emptied the whole thread list
 * while telling the user nothing was wrong. These tests pin the distinction:
 * a missing directory is honestly empty, an unreadable one is an error, and a
 * single unreadable thread is named instead of vanishing.
 */

describe("thread listing", () => {
	test("a missing threads/ directory is genuinely empty", async () => {
		const { bb, cleanup } = await makeTempWorkbench();
		try {
			const store = new ThreadRepository(bb);
			expect(await store.list()).toEqual([]);
			expect(await store.listReport()).toEqual({
				threads: [],
				unreadable: [],
			});
		} finally {
			await cleanup();
		}
	});

	test("an unreadable threads/ directory fails loudly, never as an empty list", async () => {
		const { bb, cleanup } = await makeTempWorkbench();
		try {
			// a file where the directory should be: listing it fails with ENOTDIR
			const dir = join(bb.paths.root, "threads");
			await writeFile(dir, "not a directory", "utf8");
			const store = new ThreadRepository(bb);

			try {
				await store.list();
				expect.unreachable();
			} catch (error) {
				expect(error).toBeInstanceOf(BlackboardDataError);
				expect((error as BlackboardDataError).path).toBe(dir);
			}
			await expect(store.listReport()).rejects.toBeInstanceOf(
				BlackboardDataError,
			);
		} finally {
			await cleanup();
		}
	});

	test("one unreadable thread is reported and the others stay listed", async () => {
		const { bb, cleanup } = await makeTempWorkbench();
		try {
			const store = new ThreadRepository(bb);
			const good = await store.create("好的对话");
			const brokenId = "t-broken";
			await mkdir(store.dir(brokenId), { recursive: true });
			await writeFile(store.metaFile(brokenId), "{ not json", "utf8");

			const errors: unknown[][] = [];
			const original = console.error;
			console.error = (...args: unknown[]) => void errors.push(args);
			let listed: string[] = [];
			try {
				const report = await store.listReport();
				// one bad thread does not hide its siblings
				listed = (await store.list()).map((meta) => meta.id);
				expect(report.threads.map((meta) => meta.id)).toEqual([good.id]);
				expect(report.unreadable).toEqual([brokenId]);
				expect(errors.some((args) => String(args[0]).includes(brokenId))).toBe(
					true,
				);
			} finally {
				console.error = original;
			}
			expect(listed).toEqual([good.id]);
		} finally {
			await cleanup();
		}
	});
});
