import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { type ReactNode, useEffect } from "react";
import { useChatRuntimeAdapter } from "./adapter";
import { useChatStore } from "./store";

/** Keep token updates inside the runtime; the surrounding shell stays stable. */
export function ChatProvider({ children }: { children: ReactNode }) {
	const runtime = useChatRuntimeAdapter();
	useEffect(() => {
		void useChatStore.getState().init();
	}, []);
	return (
		<AssistantRuntimeProvider runtime={runtime}>
			{children}
		</AssistantRuntimeProvider>
	);
}
