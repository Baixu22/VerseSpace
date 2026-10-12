import { createHash } from "node:crypto";

import type { WorkbenchConfig } from "../types/config";

import { HTTP_PROVIDER_DEFAULTS } from "./http-request";
import type { ChatProvider } from "./provider-capabilities";

/**
 * Session binding (phase-1 recommendation, §4.3): a thread remembers which
 * provider, model and endpoint it was started on. Caches and opaque provider
 * state only mean something on that endpoint, so the binding is what decides
 * whether a later turn may continue in place.
 *
 * The binding records the *configured* target, not whichever fallback happened
 * to answer. An outage that is covered by a fallback must not change the
 * thread's identity.
 */
export interface ThreadBinding {
	provider: ChatProvider;
	model: string;
	/** Hash of the normalised base URL. The URL itself is never stored. */
	endpoint: string;
	boundAt: string;
}

export type BindingDecision =
	/** No binding yet, or an empty thread: adopt the current configuration. */
	| { kind: "bind"; next: ThreadBinding }
	/** Same provider, model and endpoint: continue as is. */
	| { kind: "same"; next: ThreadBinding }
	/** Same provider, different model or endpoint: continue, cache starts cold. */
	| {
			kind: "rebind";
			reason: "model" | "endpoint";
			from: ThreadBinding;
			next: ThreadBinding;
	  }
	/**
	 * Different provider (a protocol switch): the turn is moved to a forked
	 * thread that inherits the transcript. Forking keeps the original thread
	 * intact and avoids mixing one protocol's state into another's.
	 */
	| { kind: "fork"; from: ThreadBinding; next: ThreadBinding };

export function endpointFingerprint(
	provider: ChatProvider,
	baseUrl?: string,
): string {
	const base =
		(baseUrl ?? "").trim() ||
		(provider in HTTP_PROVIDER_DEFAULTS
			? HTTP_PROVIDER_DEFAULTS[provider as keyof typeof HTTP_PROVIDER_DEFAULTS]
					.baseUrl
			: "");
	const normalised = base.replace(/\/+$/, "").toLowerCase();
	return createHash("sha256").update(normalised).digest("hex").slice(0, 16);
}

/** The binding the current configuration would create. */
export function bindingOf(
	chat: WorkbenchConfig["chat"],
	now: string = new Date().toISOString(),
): ThreadBinding {
	const provider = chat.provider;
	const model =
		chat.model ??
		(provider in HTTP_PROVIDER_DEFAULTS
			? HTTP_PROVIDER_DEFAULTS[provider as keyof typeof HTTP_PROVIDER_DEFAULTS]
					.model
			: "");
	return {
		provider,
		model,
		endpoint: endpointFingerprint(provider, chat.baseUrl),
		boundAt: now,
	};
}

export function decideBinding(
	binding: ThreadBinding | undefined,
	hasHistory: boolean,
	chat: WorkbenchConfig["chat"],
	now?: string,
): BindingDecision {
	const next = bindingOf(chat, now);
	if (!binding || !hasHistory) {
		return { kind: "bind", next };
	}
	if (binding.provider !== next.provider) {
		return { kind: "fork", from: binding, next };
	}
	if (binding.model !== next.model) {
		return { kind: "rebind", reason: "model", from: binding, next };
	}
	if (binding.endpoint !== next.endpoint) {
		return { kind: "rebind", reason: "endpoint", from: binding, next };
	}
	return { kind: "same", next };
}
