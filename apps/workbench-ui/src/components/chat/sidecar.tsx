import { BranchLedger } from "./branch-ledger";
import { DraftMirror } from "./draft-mirror";
import { NoticeDelivered } from "./notice-delivered";
import { ParkedBar } from "./parked-bar";
import { ResumeCard } from "./resume-card";
import { SuggestionChips } from "./suggestion-chips";
import { TribunalBar } from "./tribunal-bar";

/**
 * composer 上方的安静层：送达指示 → 恢复卡 → 待裁决 → 分支账本 → 停放快照 → 建议条。
 * 裁决队列排在分支账本之前——它是「答不了、交给人」的通道，比信息性的分支汇总更需要注意。
 */
export function ThreadSidecar() {
	return (
		<>
			<DraftMirror />
			<NoticeDelivered />
			<ResumeCard />
			<TribunalBar />
			<BranchLedger />
			<ParkedBar />
			<SuggestionChips />
		</>
	);
}
