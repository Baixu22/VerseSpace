import { expect, test } from "bun:test";
import { workbenchConfigSchema } from "../types/config";
import { publicChatConfig } from "./credentials";

test("fallback targets accept only HTTP protocols and bounded attempts", () => {
	const parsed = workbenchConfigSchema.parse({
		chat: {
			provider: "openai-chat",
			fallbacks: [{ provider: "anthropic", model: "claude-sonnet-4-5" }],
			maxAttempts: 3,
		},
	});
	expect(parsed.chat.fallbacks).toHaveLength(1);
	expect(() =>
		workbenchConfigSchema.parse({
			chat: { provider: "openai-chat", fallbacks: [{ provider: "claude" }] },
		}),
	).toThrow();
	expect(() =>
		workbenchConfigSchema.parse({
			chat: { provider: "openai-chat", maxAttempts: 9 },
		}),
	).toThrow();
	expect(() =>
		workbenchConfigSchema.parse({
			chat: {
				provider: "openai-chat",
				fallbacks: Array.from({ length: 5 }, () => ({ provider: "anthropic" })),
			},
		}),
	).toThrow();
});

test("UI surface never returns a fallback's secret, only whether one is set", () => {
	const chat = workbenchConfigSchema.parse({
		chat: {
			provider: "openai-chat",
			fallbacks: [
				{ provider: "anthropic", apiKey: "sk-fallback-secret" },
				{ provider: "openai-responses" },
			],
		},
	}).chat;
	const shown = JSON.stringify(publicChatConfig(chat));
	expect(shown).not.toContain("sk-fallback-secret");
	expect(publicChatConfig(chat).fallbacks).toEqual([
		{
			provider: "anthropic",
			model: undefined,
			baseUrl: undefined,
			hasKey: true,
		},
		{
			provider: "openai-responses",
			model: undefined,
			baseUrl: undefined,
			hasKey: false,
		},
	]);
});
