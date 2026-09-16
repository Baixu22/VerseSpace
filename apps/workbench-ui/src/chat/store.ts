import { create } from "zustand";
import { createDraftSlice } from "./draft-slice";
import { loadParked } from "./draft-storage";
import type { StoredMessage } from "./message-types";
import { EMPTY } from "./message-types";
import { createReloadSlice } from "./reload-slice";
import { createResumeSlice } from "./resume-slice";
import { createSelectionSlice } from "./selection-slice";
import { createSendSlice } from "./send-slice";
import type { ChatState } from "./store-types";
import { createThreadSlice } from "./thread-slice";

export type {
	DecisionPoint,
	MessagePart,
	ParkedItem,
	PermissionMode,
	StoredMessage,
	Suggestion,
	ThreadMeta,
} from "./message-types";
export type {
	ReadSetDiff,
	ReadSetDiffFact,
	ResumeBeat,
	ResumeCardAnnotation,
	ResumeCardFactRow,
	ResumeCardNarrativeRow,
	ResumeCardView,
	ResumeNote,
} from "./resume-types";

export const useChatStore = create<ChatState>((...args) => ({
	threads: [],
	activeId: null,
	messages: {},
	runningThreadId: null,
	forkNotice: null,
	suggestions: [],
	decisionPoints: [],
	drafts: {},
	parked: loadParked(),
	resumeNote: null,
	resumeDelta: 0,
	readSetDiff: null,
	resumeCard: null,
	resumeCardDismissed: false,
	resumeCardRevealed: false,
	noticesDelivered: null,
	canPromote: false,
	...createSelectionSlice(...args),
	...createDraftSlice(...args),
	...createResumeSlice(...args),
	...createThreadSlice(...args),
	...createSendSlice(...args),
	...createReloadSlice(...args),
}));
export function useActiveMessages(): StoredMessage[] {
	return (
		useChatStore((s) => (s.activeId ? s.messages[s.activeId] : undefined)) ??
		EMPTY
	);
}
