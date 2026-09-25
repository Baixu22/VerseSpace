import type { ChatConfig } from "./config";

export type ChatProvider = ChatConfig["provider"];

export interface ProviderOption {
	value: ChatProvider;
	label: string;
	description: string;
}

/**
 * TF-0255 (F-01): the provider options are data, so the browser spec derives its
 * expectation from the same table the panel renders instead of copying a count.
 * `toHaveCount(4)` had already gone stale when the codex lane landed, and nobody
 * noticed because the E2E suite does not run in CI or on this host.
 *
 * The ids mirror the backend's single capabilities table
 * (`packages/workbench/src/chat/provider-capabilities.ts`); the guard below turns
 * "a provider exists but the panel does not offer it" into a type error.
 */
export const PROVIDERS = [
	{
		value: "claude",
		label: "Claude Code · 本机",
		description: "使用本机登录信息，无需 API Key。",
	},
	{
		value: "codex",
		label: "Codex · 本机",
		description: "监督本机 codex CLI（app-server 协议），同样留下工具足迹。",
	},
	{
		value: "openai-chat",
		label: "OpenAI · Chat Completions",
		description: "支持 OpenAI 及兼容服务。",
	},
	{
		value: "openai-responses",
		label: "OpenAI · Responses",
		description: "支持推理力度与 Responses 接口。",
	},
	{
		value: "anthropic",
		label: "Anthropic · Messages",
		description: "通过 Anthropic 接口使用 Claude。",
	},
] as const satisfies readonly ProviderOption[];

/** The provider ids the panel actually offers, in display order. */
export type OfferedProvider = (typeof PROVIDERS)[number]["value"];

/**
 * Compile-time guard: adding a provider to `ChatConfig` without offering it in
 * `PROVIDERS` is a type error here, not a silently stale dropdown count in a
 * spec that CI does not run.
 */
export const ALL_PROVIDERS_OFFERED: Record<
	Exclude<ChatProvider, OfferedProvider>,
	never
> = {};
