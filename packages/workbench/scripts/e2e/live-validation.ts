/** Independent acceptance for the live coding scenario, with bounded repairs. */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const CASES = [
	[
		"基址",
		"https://openrouter.ai/api/v1",
		"https://openrouter.ai/api/v1/chat/completions",
	],
	[
		"完整端点",
		"https://openrouter.ai/api/v1/chat/completions",
		"https://openrouter.ai/api/v1/chat/completions",
	],
	[
		"尾部弯引号",
		"https://openrouter.ai/api/v1/chat/completions”",
		"https://openrouter.ai/api/v1/chat/completions",
	],
	["成对引号", ' "https://x.test/v1/" ', "https://x.test/v1/chat/completions"],
	[
		"代理路径与 query",
		"https://x.test/team/v1/?route=a%20b#old",
		"https://x.test/team/v1/chat/completions?route=a%20b",
	],
	[
		"完整端点多余斜杠",
		"http://localhost:8080/v1/chat/completions///",
		"http://localhost:8080/v1/chat/completions",
	],
	["非法 scheme", "file:///private", null],
	["嵌入凭据", "https://user:password@host/v1", null],
	[
		"路径与 query 中的 @ 不是凭据",
		"https://x.test/team@one/v1/?owner=a@b.com#old",
		"https://x.test/team@one/v1/chat/completions?owner=a@b.com",
	],
	["完整端点也须拒绝非法 scheme", "ftp://host/v1/chat/completions", null],
	[
		"完整端点也须拒绝嵌入凭据",
		"https://user:password@host/v1/chat/completions",
		null,
	],
	["相对路径", "/v1", null],
] as const;

interface Failure {
	name: string;
	input: string;
	expected: string | null;
	actual: string | null;
}
export interface UrlValidation {
	total: number;
	passed: number;
	failures: Failure[];
}

function checkEndpoint(candidate: (input: string) => unknown): UrlValidation {
	const failures: Failure[] = [];
	for (const [name, input, expected] of CASES) {
		let actual: string | null;
		try {
			const value = candidate(input);
			actual = typeof value === "string" ? value : "[非字符串返回值]";
		} catch {
			actual = null;
		}
		if (actual !== expected) failures.push({ name, input, expected, actual });
	}
	return {
		total: CASES.length,
		passed: CASES.length - failures.length,
		failures,
	};
}

export async function verifyLiveImplementation(
	file: string,
): Promise<UrlValidation> {
	// Fresh process avoids module caching after a repair. The generated code
	// does not inherit provider credentials from the live runner's environment.
	const absolute = resolve(file);
	// Full Windows runs observed premature spawnSync ETIMEDOUT failures;
	// execFile avoids that observed failure with an asynchronous timeout.
	const child = await new Promise<{ status: number; stdout: string }>(
		(done, fail) => {
			execFile(
				process.execPath,
				[import.meta.path, absolute],
				{
					encoding: "utf8",
					cwd: dirname(absolute),
					windowsHide: true,
					timeout: 10_000,
					maxBuffer: 256 * 1024,
					env: {
						PATH: process.env.PATH,
						SystemRoot: process.env.SystemRoot,
						TEMP: process.env.TEMP,
						TMP: process.env.TMP,
					},
				},
				(error, stdout) => {
					if (error && error.code !== 1)
						fail(
							new Error(
								`模型产物独立检查进程失败或超时（code=${error.code}, signal=${error.signal}）`,
							),
						);
					else done({ status: error ? 1 : 0, stdout });
				},
			);
		},
	);
	try {
		const result = JSON.parse(child.stdout) as UrlValidation;
		if (
			result.total !== CASES.length ||
			!Number.isInteger(result.passed) ||
			result.passed < 0 ||
			result.passed > result.total ||
			!Array.isArray(result.failures) ||
			result.failures.length !== result.total - result.passed ||
			child.status !== (result.passed === result.total ? 0 : 1)
		)
			throw new Error("独立检查结果不一致");
		return result;
	} catch {
		throw new Error("模型产物未返回独立检查结果");
	}
}

export async function validateWithCorrections(
	projectDir: string,
	correct: (failures: Failure[]) => Promise<unknown>,
): Promise<UrlValidation[]> {
	const checks: UrlValidation[] = [];
	await mkdir(join(projectDir, "runs"), { recursive: true });
	for (let attempt = 0; attempt <= 2; attempt++) {
		const check = await verifyLiveImplementation(
			join(projectDir, "src/base-url.ts"),
		);
		checks.push(check);
		await writeFile(
			join(projectDir, "runs/live-validation.json"),
			JSON.stringify(checks, null, 2),
		);
		if (check.passed === check.total) return checks;
		if (attempt < 2) await correct(check.failures);
	}
	throw new Error(
		"模型产物独立检查仍未通过（已纠正两轮），见 runs/live-validation.json",
	);
}

if (import.meta.main) {
	try {
		const file = process.argv[2];
		if (!file) throw new Error("缺少待检查文件");
		const candidate = await import(pathToFileURL(resolve(file)).href);
		if (typeof candidate.buildChatEndpoint !== "function")
			throw new Error("缺少 buildChatEndpoint");
		const result = checkEndpoint(candidate.buildChatEndpoint);
		console.log(JSON.stringify(result));
		process.exitCode = result.passed === result.total ? 0 : 1;
	} catch {
		console.error("无法执行模型产物的独立检查");
		process.exitCode = 2;
	}
}
