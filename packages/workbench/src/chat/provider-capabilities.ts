/**
 * Provider capabilities as data (TF-0204).
 *
 * Before this file, "what can this provider do" was answered by comparing the
 * provider name at each call site: `provider === "claude"` decided whether
 * reads leave footprints, whether a fork can inherit real agent context,
 * whether an API key is required, and which channel a turn takes. Four
 * questions, one spelling — and adding a provider meant finding every copy.
 *
 * The table below is the single answer. Two rules keep it honest:
 *
 * 1. This is about CAPABILITIES, not wire formats. The HTTP lane still picks
 *    `anthropic` vs `openai-chat` bodies in its own module (`http-request.ts`,
 *    `http-stream.ts`) — that choice is about which API shape to speak, and
 *    putting it here would turn "capabilities" into "everything about a
 *    provider", which is how these tables rot.
 * 2. A capability is only listed when something actually branches on it. Any
 *    field here has a caller; a field nobody reads is a guess about the
 *    future, not a fact about the present.
 */

import type { WorkbenchConfig } from "../types/config";

export type ChatProvider = WorkbenchConfig["chat"]["provider"];

/** Whether the provider's reads come back as footprints (tool channel) or not at all. */
export type ReadObservability = "footprint" | "unobservable";

export interface ProviderCapabilities {
	/** Which lane a turn takes: the local CLI, or an HTTP endpoint. */
	channel: "local-cli" | "http";
	/** Reads come back as footprints (tool channel) or not at all. */
	observesFootprint: boolean;
	/** A child thread can inherit the parent's real agent context (not just its transcript). */
	supportsFork: boolean;
	/** Events arrive as structured JSON stream items rather than text deltas. */
	supportsStreamJson: boolean;
	/** Needs an API key before it can run at all. */
	requiresApiKey: boolean;
}

export const PROVIDER_CAPABILITIES: Record<ChatProvider, ProviderCapabilities> =
	{
		claude: {
			channel: "local-cli",
			observesFootprint: true,
			supportsFork: true,
			supportsStreamJson: true,
			requiresApiKey: false,
		},
		codex: {
			// TF-0249 / ADR-0017: a supervised external CLI, like claude. Its
			// commandExecution items leave read/write footprints. No --fork-session
			// equivalent (resume reattaches by thread id but cannot tail-fork a
			// parent's context), and it streams app-server JSON-RPC, not stream-json
			// — so supportsStreamJson is false: nothing branches on it as "claude's
			// wire shape", and codex fixture replay drives its own reducer.
			channel: "local-cli",
			observesFootprint: true,
			supportsFork: false,
			supportsStreamJson: false,
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
	};

export function capabilitiesOf(provider: ChatProvider): ProviderCapabilities {
	return PROVIDER_CAPABILITIES[provider];
}

/** The observability a provider's reads will have, derived from its capabilities. */
export function readObservabilityOf(provider: ChatProvider): ReadObservability {
	return capabilitiesOf(provider).observesFootprint
		? "footprint"
		: "unobservable";
}
