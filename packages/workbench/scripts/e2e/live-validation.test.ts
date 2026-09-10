import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { makeTempWorkbench } from "../../src/test/fixtures";
import {
	validateWithCorrections,
	verifyLiveImplementation,
} from "./live-validation";

const valid = `import { httpEndpoint } from ${JSON.stringify(pathToFileURL(resolve(import.meta.dir, "../../src/chat/http-endpoint.ts")).href)};
if (process.env.E2E_LLM_KEY) throw new Error("凭据不应传给模型产物");
export const buildChatEndpoint = (base: string) => httpEndpoint(base, "/chat/completions");`;
const invalid =
	'export const buildChatEndpoint = (base: string) => base + "/chat/completions";';

test("独立验收拦住错误实现，纠正后重新加载且不传模型密钥", async () => {
	const ws = await makeTempWorkbench();
	const previousKey = process.env.E2E_LLM_KEY;
	try {
		process.env.E2E_LLM_KEY = "test-only-credential";
		await mkdir(join(ws.projectDir, "src"));
		const file = join(ws.projectDir, "src/base-url.ts");
		await writeFile(file, invalid);
		expect((await verifyLiveImplementation(file)).passed).toBeLessThan(12);
		let corrections = 0;
		const checks = await validateWithCorrections(
			ws.projectDir,
			async (failures) => {
				corrections++;
				expect(failures.some((failure) => failure.name === "尾部弯引号")).toBe(
					true,
				);
				await writeFile(file, valid);
			},
		);
		expect(corrections).toBe(1);
		expect(checks).toHaveLength(2);
		expect(checks.at(-1)).toMatchObject({
			total: 12,
			passed: 12,
			failures: [],
		});
		expect(
			JSON.parse(
				await readFile(
					join(ws.projectDir, "runs/live-validation.json"),
					"utf8",
				),
			),
		).toEqual(checks);
	} finally {
		if (previousKey === undefined) delete process.env.E2E_LLM_KEY;
		else process.env.E2E_LLM_KEY = previousKey;
		await ws.cleanup();
	}
});

test("独立检查失败只允许两轮纠正，保留三次结果后明确失败", async () => {
	const ws = await makeTempWorkbench();
	try {
		await mkdir(join(ws.projectDir, "src"));
		await writeFile(join(ws.projectDir, "src/base-url.ts"), invalid);
		let corrections = 0;
		await expect(
			validateWithCorrections(ws.projectDir, async () => {
				corrections++;
			}),
		).rejects.toThrow("已纠正两轮");
		expect(corrections).toBe(2);
		const checks = JSON.parse(
			await readFile(join(ws.projectDir, "runs/live-validation.json"), "utf8"),
		);
		expect(checks).toHaveLength(3);
	} finally {
		await ws.cleanup();
	}
});
