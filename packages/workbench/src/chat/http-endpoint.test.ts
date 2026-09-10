import { expect, test } from "bun:test";
import { httpEndpoint } from "./http-endpoint";

test("provider endpoints accept bases, full endpoints, pasted quotes, and proxy prefixes", () => {
	for (const [base, endpoint, expected] of [
		[
			"https://openrouter.ai/api/v1",
			"/chat/completions",
			"https://openrouter.ai/api/v1/chat/completions",
		],
		[
			"https://openrouter.ai/api/v1/chat/completions",
			"/chat/completions",
			"https://openrouter.ai/api/v1/chat/completions",
		],
		[
			"  “https://openrouter.ai/api/v1/chat/completions”  ",
			"/chat/completions",
			"https://openrouter.ai/api/v1/chat/completions",
		],
		[
			'"https://proxy.test/team/v1///?route=a%20b#old"',
			"/chat/completions",
			"https://proxy.test/team/v1/chat/completions?route=a%20b",
		],
		[
			"http://localhost:8080/v1/responses/",
			"/responses",
			"http://localhost:8080/v1/responses",
		],
		[
			"https://api.anthropic.com",
			"/v1/messages",
			"https://api.anthropic.com/v1/messages",
		],
		[
			"https://proxy.test/team/v1/",
			"/v1/messages",
			"https://proxy.test/team/v1/messages",
		],
		[
			"https://proxy.test/team/v1/messages",
			"/v1/messages",
			"https://proxy.test/team/v1/messages",
		],
	] as const)
		expect(httpEndpoint(base, endpoint)).toBe(expected);
});

test("invalid or credential-bearing URLs fail without reflecting private input", () => {
	for (const base of [
		"",
		"not a URL private-key",
		"file:///tmp/private-key",
		"ftp://host/path",
		"https://user:private-key@host/v1",
	]) {
		try {
			httpEndpoint(base, "/chat/completions");
			throw new Error("accepted unsafe URL");
		} catch (error) {
			expect(String(error)).toContain("模型服务");
			expect(String(error)).not.toContain("private-key");
		}
	}
});
