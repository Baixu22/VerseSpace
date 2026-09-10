import { unstable_useComposerInput } from "@assistant-ui/react";
import { useEffect, useRef } from "react";
import { useChatStore } from "../../chat/store";

/** Mirrors composer text and parks it when the visible thread changes. */
export function DraftMirror() {
	const activeId = useChatStore((s) => s.activeId);
	const composer = unstable_useComposerInput();
	const seen = useRef({ id: activeId, value: composer.value });
	useEffect(() => {
		const prev = seen.current;
		if (prev.id && prev.id !== activeId) {
			const state = useChatStore.getState();
			const alreadyParked = (state.parked[prev.id] ?? []).some(
				(item) => item.text === prev.value.trim(),
			);
			if (prev.value.trim() && !alreadyParked) {
				state.parkDraft(prev.id, prev.value);
			}
			if (composer.value) composer.setText("");
			seen.current = { id: activeId, value: "" };
			return;
		}
		seen.current = { id: activeId, value: composer.value };
		if (activeId) useChatStore.getState().setDraft(activeId, composer.value);
	}, [activeId, composer.value]);
	return null;
}
