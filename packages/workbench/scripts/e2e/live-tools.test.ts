import { expect, test } from "bun:test";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempWorkbench } from "../../src/test/fixtures";
import { executeLiveTool } from "./live-tools";

test("live tools perform actual bounded reads/writes and reject path escapes", async () => {
	const ws = await makeTempWorkbench();
	try {
		await executeLiveTool(ws.projectDir, "Write", {
			file_path: "src/demo.ts",
			content: "one\ntwo\nthree\n",
		});
		expect(await readFile(join(ws.projectDir, "src/demo.ts"), "utf8")).toBe(
			"one\ntwo\nthree\n",
		);
		expect(
			(
				await executeLiveTool(ws.projectDir, "Read", {
					file_path: "src/demo.ts",
					offset: 2,
					limit: 1,
				})
			).content,
		).toBe("two");
		for (const file_path of [
			"../secret",
			"src/../secret",
			"src/.env",
			"src/a:stream",
			"/src/demo.ts",
			"C:\\secret",
			".workbench/workbench.yaml",
		]) {
			await expect(
				executeLiveTool(ws.projectDir, "Read", { file_path }),
			).rejects.toThrow();
		}
		await expect(
			executeLiveTool(
				ws.projectDir,
				"Write",
				{ file_path: "src/demo.ts", content: "changed" },
				true,
			),
		).rejects.toThrow("plan");
		await expect(
			executeLiveTool(ws.projectDir, "Bash", { command: "echo no" }),
		).rejects.toThrow();
		await mkdir(join(ws.projectDir, "outside"));
		await writeFile(join(ws.projectDir, "outside/secret.txt"), "secret");
		await symlink(
			join(ws.projectDir, "outside"),
			join(ws.projectDir, "src/link"),
			"junction",
		);
		await expect(
			executeLiveTool(ws.projectDir, "Read", {
				file_path: "src/link/secret.txt",
			}),
		).rejects.toThrow("链接");
		await expect(
			executeLiveTool(ws.projectDir, "Write", {
				file_path: "src/link/secret.txt",
				content: "no",
			}),
		).rejects.toThrow("链接");
		expect(
			await readFile(join(ws.projectDir, "outside/secret.txt"), "utf8"),
		).toBe("secret");
	} finally {
		await ws.cleanup();
	}
});
