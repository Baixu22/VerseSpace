import type { ThreadContext } from "../chat/thread-context";
import type { ChatThreads } from "../chat/threads";

/** Tests for internal queue/lifecycle contracts share one access point. */
export function chatContext(chat: ChatThreads): ThreadContext {
	return (chat as unknown as { context: ThreadContext }).context;
}
