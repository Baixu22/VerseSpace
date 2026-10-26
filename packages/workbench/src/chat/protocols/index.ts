import { anthropicCodec } from "./anthropic.ts";
import { openAiChatCodec } from "./openai-chat.ts";
import { openAiResponsesCodec } from "./openai-responses.ts";
import type { HttpProvider, ProtocolCodec } from "./types.ts";

export { classifyFailure, kindFromStatus } from "./errors.ts";
export type { HttpProvider, ProtocolCodec } from "./types.ts";
export {
	type CodecRequest,
	type CodecTurn,
	type FailureKind,
	finalizeUsage,
	mergeUsage,
	type ParsedFrame,
	type StreamError,
	type TurnUsage,
	type UsagePatch,
} from "./types.ts";

const CODECS: Record<HttpProvider, ProtocolCodec> = {
	"openai-chat": openAiChatCodec,
	"openai-responses": openAiResponsesCodec,
	anthropic: anthropicCodec,
};

export function codecFor(provider: HttpProvider): ProtocolCodec {
	return CODECS[provider];
}

export function isHttpProvider(value: string): value is HttpProvider {
	return Object.hasOwn(CODECS, value);
}
