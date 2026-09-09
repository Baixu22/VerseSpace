import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertLiveAuthorized } from "./live-auth";

test("accepts both isolated and tenant live authorization markers", async () => {
	const root = await mkdtemp(join(tmpdir(), "live-auth-"));
	try {
		await writeFile(
			join(root, ".live-e2e-authorized"),
			"isolated-live-model-fixture\n",
		);
		expect(await assertLiveAuthorized(root)).toBe("isolated-live-model-fixture");
		await writeFile(
			join(root, ".live-e2e-authorized"),
			"tenant-live-model-accumulation\n",
		);
		expect(await assertLiveAuthorized(root)).toBe(
			"tenant-live-model-accumulation",
		);
		await writeFile(join(root, ".live-e2e-authorized"), "not-a-marker\n");
		await expect(assertLiveAuthorized(root)).rejects.toThrow("授权标记");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
