import { describe, expect, test } from "bun:test";
import type { WorkbenchConfig } from "../types/config";
import { workbenchConfigSchema } from "../types/config";
import { publicChatConfig } from "./credentials";
import {
	capabilitiesOf,
	PROVIDER_CAPABILITIES,
	readObservabilityOf,
} from "./provider-capabilities";

const PROVIDERS = [
	"claude",
	"openai-chat",
	"openai-responses",
	"anthropic",
] as const;

describe("provider 能力表（TF-0204）", () => {
	// 矩阵写全值而不是写「claude 为真」：能力表的价值就在于它是可核对的，
	// 断言越具体，改动它时越难悄悄改错一个格子。
	test("四种 provider 的能力矩阵", () => {
		expect(
			Object.fromEntries(PROVIDERS.map((p) => [p, capabilitiesOf(p)])),
		).toEqual({
			claude: {
				channel: "local-cli",
				observesFootprint: true,
				supportsFork: true,
				supportsStreamJson: true,
				requiresApiKey: false,
			},
			"openai-chat": {
				channel: "http",
				observesFootprint: false,
				supportsFork: false,
				supportsStreamJson: false,
				requiresApiKey: true,
			},
			"openai-responses": {
				channel: "http",
				observesFootprint: false,
				supportsFork: false,
				supportsStreamJson: false,
				requiresApiKey: true,
			},
			anthropic: {
				channel: "http",
				observesFootprint: false,
				supportsFork: false,
				supportsStreamJson: false,
				requiresApiKey: true,
			},
		});
	});

	test("表恰好覆盖 schema 允许的 provider（多一个少一个都不行）", () => {
		// Record<ChatProvider, …> 的类型签名已经保证「少一个」编译不过；
		// 这条在运行期把两边的集合钉死，避免将来有人用 as 绕开类型。
		expect(Object.keys(PROVIDER_CAPABILITIES).sort()).toEqual(
			[...PROVIDERS].sort(),
		);
		const defaults = workbenchConfigSchema.parse({});
		expect(capabilitiesOf(defaults.chat.provider)).toBeDefined();
	});

	test("可观测性由能力推导，不再各自比较 provider 名字", () => {
		for (const provider of PROVIDERS) {
			expect(readObservabilityOf(provider)).toBe(
				capabilitiesOf(provider).observesFootprint
					? "footprint"
					: "unobservable",
			);
		}
	});

	test("只有本机 CLI 车道不需要 API Key，且不能同时是 HTTP 车道", () => {
		for (const provider of PROVIDERS) {
			const capabilities = capabilitiesOf(provider);
			expect(capabilities.requiresApiKey).toBe(capabilities.channel === "http");
		}
	});

	test("publicChatConfig 把能力带给 UI，且不泄露密钥", () => {
		const chat = {
			provider: "openai-chat",
			apiKey: "sk-secret-value",
		} as WorkbenchConfig["chat"];
		const published = publicChatConfig(chat);
		expect(published.capabilities).toEqual(capabilitiesOf("openai-chat"));
		expect(published.capabilities.observesFootprint).toBe(false);
		expect(JSON.stringify(published)).not.toContain("sk-secret-value");
		expect(published.hasKey).toBe(true);
	});
});
