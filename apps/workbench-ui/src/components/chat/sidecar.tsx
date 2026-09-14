import { DecisionLedger } from "./decision-ledger";
import { DraftMirror } from "./draft-mirror";
import { NoticeDelivered } from "./notice-delivered";
import { ParkedBar } from "./parked-bar";
import { ResumeCard } from "./resume-card";
import { SuggestionChips } from "./suggestion-chips";

/** composer 上方的安静层：送达指示 → 恢复卡 → 账本 → 停放快照 → 建议条。 */
export function ThreadSidecar() {
	return (
		<>
			<DraftMirror />
			<NoticeDelivered />
			<ResumeCard />
			<DecisionLedger />
			<ParkedBar />
			<SuggestionChips />
		</>
	);
}
