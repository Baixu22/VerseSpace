import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { RotateCcw, X } from "@/components/icon";
import { useChatStore } from "../../chat/store";
import { FADE_IN, STAGGER_PARENT, TWEEN_DISCLOSURE } from "../../lib/motion";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tooltip } from "../ui/tooltip";
import { ResumeArtifactRows } from "./resume-card-artifacts";
import { ResumeFactRow, ResumeNarrativeRow } from "./resume-card-rows";

/** Dual-channel restore card: facts first, narrative second (TF-0128). */
export function ResumeCard() {
	const card = useChatStore((s) => s.resumeCard);
	const note = useChatStore((s) => s.resumeNote);
	const delta = useChatStore((s) => s.resumeDelta);
	const dismissed = useChatStore((s) => s.resumeCardDismissed);
	const revealed = useChatStore((s) => s.resumeCardRevealed);
	const readSetDiff = useChatStore((s) => s.readSetDiff);
	const artifactReviews = useChatStore((s) => s.artifactReviews);
	const consume = useChatStore((s) => s.consumeResumeNote);
	const dismiss = useChatStore((s) => s.dismissResumeCard);
	const reportShown = useChatStore((s) => s.reportResumeCardShown);
	const [factsExpanded, setFactsExpanded] = useState(false);
	// TF-0199 展示观测：渲染出带分支行的卡片就上报（fit 指标 7 的分母）。
	// 按恢复边界去重——同一 baseline + 同一组行只报一次，后台刷新与
	// StrictMode 双跑都不会重复计数；换恢复基线（新一次离开）才再报。
	const shownKeyRef = useRef<string | null>(null);
	useEffect(() => {
		if (!card || dismissed) return;
		const branchRows = card.facts.filter(
			(fact) => fact.source === "branch" && fact.branch,
		);
		if (branchRows.length === 0) return;
		const threadId = useChatStore.getState().activeId;
		const key = `${threadId}|${readSetDiff?.baseline?.eventId ?? ""}|${branchRows
			.map((fact) => fact.branch!.threadId)
			.join(",")}`;
		if (shownKeyRef.current === key) return;
		shownKeyRef.current = key;
		void reportShown(
			branchRows.map((fact) => `branch:${fact.branch!.threadId}`),
		);
	}, [card, dismissed, readSetDiff, reportShown]);
	const showCard = Boolean(card && (!dismissed || revealed));
	const showArtifacts = Boolean(artifactReviews?.total);
	if (!showCard && !showArtifacts) return null;

	// 预览条数随卡片载荷下发（服务端 FACTS_PREVIEW_COUNT 是唯一来源）——
	// 客户端不再自带一份同值常量（2026-09-13 收尾 §5.6）
	const visibleFacts = card
		? factsExpanded
			? card.facts
			: card.facts.slice(0, card.factsPreviewCount)
		: [];
	const hiddenCount = card
		? Math.max(0, card.facts.length - visibleFacts.length)
		: 0;
	return (
		<motion.section
			{...FADE_IN}
			transition={TWEEN_DISCLOSURE}
			aria-label="恢复卡"
			className="mb-3 overflow-hidden rounded-xl border border-border-subtle bg-bg-surface shadow-sm"
		>
			<header className="flex items-center gap-2 border-b border-border-subtle px-3 py-2.5">
				<div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent-default/10 text-accent-default">
					<RotateCcw className="size-3.5" />
				</div>
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-1.5">
						<span className="text-small font-medium text-fg-default">
							恢复卡
						</span>
						{note && showCard ? (
							<Badge
								variant="secondary"
								className={cn(
									"h-4 px-1.5 text-small font-normal",
									note.confirmedAt && "text-status-success",
								)}
							>
								{note.confirmedAt ? "已确认" : "待确认"}
							</Badge>
						) : null}
						{showCard && delta > 0 ? (
							<Badge
								variant="outline"
								className="h-4 px-1.5 text-small font-normal"
							>
								新增 {delta} 条
							</Badge>
						) : null}
					</div>
					<p className="mt-0.5 truncate text-small text-fg-subtle">
						{showCard && note
							? `离开于 ${new Date(note.draftedAt).toLocaleString()}`
							: showCard && card
								? card.coverage.text
								: `${artifactReviews?.total ?? 0} 项产物检查`}
					</p>
				</div>
				{showCard && note && !note.confirmedAt ? (
					<Button
						type="button"
						variant="ghost"
						size="xs"
						className="text-status-success"
						onClick={() => void useChatStore.getState().confirmResumeNote()}
					>
						确认
					</Button>
				) : null}
				{showCard ? (
					<Tooltip content="收起恢复卡">
						<Button
							type="button"
							variant="ghost"
							size="icon"
							className="text-fg-muted"
							aria-label="收起"
							onClick={() => void dismiss()}
						>
							<X className="size-3.5" />
						</Button>
					</Tooltip>
				) : null}
			</header>

			{showCard && card ? (
				<div className="grid gap-3 px-3 py-3 lg:grid-cols-[minmax(0,1.15fr)_minmax(15rem,0.85fr)]">
					<div className="min-w-0">
						<div className="flex items-center justify-between gap-2">
							<span className="shrink-0 text-small font-medium text-fg-muted">
								事实 {card.facts.length > 0 ? `· ${card.facts.length}` : ""}
							</span>
							<Tooltip content={card.coverage.text}>
								<span className="min-w-0 truncate text-small text-fg-subtle">
									{card.coverage.text}
								</span>
							</Tooltip>
						</div>
						{card.facts.length > 0 ? (
							<>
								<motion.ul
									initial="hidden"
									animate="show"
									variants={STAGGER_PARENT}
									className="mt-2 space-y-1.5"
								>
									<AnimatePresence initial={false}>
										{visibleFacts.map((fact) => (
											<ResumeFactRow
												key={`${fact.source}-${fact.branch?.threadId ?? fact.path}-${fact.currentVersion ?? "missing"}`}
												fact={fact}
											/>
										))}
									</AnimatePresence>
								</motion.ul>
								{hiddenCount > 0 ? (
									<Button
										type="button"
										variant="ghost"
										size="xs"
										className="mt-1 text-fg-subtle"
										onClick={() => {
											setFactsExpanded(true);
											void consume("facts");
										}}
									>
										及另 {hiddenCount} 条
									</Button>
								) : null}
							</>
						) : (
							<p className="mt-2 text-small text-fg-subtle">
								{card.coverage.status === "unknown"
									? "尚无可比较的文件记录。"
									: "没有检测到前提变化。"}
							</p>
						)}
					</div>

					{card.narrative.length > 0 || delta > 0 ? (
						<div className="min-w-0 border-t border-border-subtle pt-3 lg:border-l lg:border-t-0 lg:pl-3 lg:pt-0">
							<span className="text-small font-medium text-fg-muted">
								接力脉络
							</span>
							{showCard && delta > 0 ? (
								<p className="mt-2 rounded-md bg-accent-default/8 px-2 py-1.5 text-small text-fg-muted">
									你不在时这条对话多了 {delta} 条，往下翻看新内容。
								</p>
							) : null}
							<motion.ol
								initial="hidden"
								animate="show"
								variants={STAGGER_PARENT}
								className="relative mt-2 space-y-3 before:absolute before:bottom-1 before:left-[3px] before:top-2 before:w-px before:bg-border-subtle"
							>
								{card.narrative.map((row, index) => (
									<ResumeNarrativeRow key={`${row.kind}-${index}`} row={row} />
								))}
							</motion.ol>
						</div>
					) : null}
				</div>
			) : null}
			<ResumeArtifactRows projection={artifactReviews} />
		</motion.section>
	);
}
