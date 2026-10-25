import { useEffect, useState } from "react";
import { Check, Copy } from "@/components/icon";
import type {
	ArtifactReviewProjectionItem,
	ArtifactReviewProjectionView,
	ArtifactReviewStatus,
} from "../../chat/resume-types";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";

import { Button } from "../ui/button";
import { EvidenceRefs } from "./evidence-refs";

const STATUS: Record<
	ArtifactReviewStatus,
	{ label: string; className: string }
> = {
	current: {
		label: "检查当前",
		className: "bg-status-success/10 text-status-success",
	},
	stale: {
		label: "需要重验",
		className: "bg-status-warning/10 text-status-warning",
	},
	pending: {
		label: "等待检查",
		className: "bg-accent-default/10 text-accent-default",
	},
	failed: {
		label: "检查失败",
		className: "bg-status-danger/10 text-status-danger",
	},
	unknown: {
		label: "无法确认",
		className: "bg-fg-subtle/10 text-fg-subtle",
	},
};

const ORIGIN = {
	"tool-observed": "来源已观察",
	"fs-sample": "仅有文件采样",
	declared: "仅声明来源",
	unknown: "来源未知",
} as const;

const INPUTS = {
	matched: "输入一致",
	different: "输入有变化",
	unknown: "输入未知",
} as const;

const RESULT: Record<string, string> = {
	passed: "检查通过",
	failed: "检查失败",
	needs_human: "需要人工判断",
	timeout: "检查超时",
	skipped: "检查跳过",
	unknown: "检查未知",
};

const TARGET = {
	"target-checked": "目标范围已核对",
	"inputs-match": "输入与目标一致",
	"inputs-differ": "输入与目标不同",
	unknown: "目标未知",
} as const;

const shortHash = (value: string) => value.slice(0, 10);
const statusCount = (projection: ArtifactReviewProjectionView) =>
	(Object.entries(projection.counts) as Array<[ArtifactReviewStatus, number]>)
		.filter(([, count]) => count > 0)
		.map(([status]) => `${STATUS[status].label} ${projection.counts[status]}`)
		.join(" · ");

function ArtifactReviewRow({ item }: { item: ArtifactReviewProjectionItem }) {
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return;
		const timer = window.setTimeout(() => setCopied(false), 1400);
		return () => window.clearTimeout(timer);
	}, [copied]);
	const targetLabel =
		item.target.change === "outside-declared-range"
			? "目标范围外推进"
			: item.target.change === "revalidation-required"
				? "目标变化待重验"
				: TARGET[item.target.status];
	const verification = item.facts.verification;
	const copyCommand = async () => {
		try {
			await navigator.clipboard.writeText(item.revalidateCommand);
			setCopied(true);
		} catch {
			setCopied(false);
		}
	};
	return (
		<li
			data-artifact-status={item.status}
			className="rounded-lg border border-border-subtle bg-bg-base/70 p-2.5"
		>
			<div className="flex min-w-0 items-start gap-2">
				<Badge
					variant="outline"
					className={`h-5 px-1.5 text-nano ${STATUS[item.status].className}`}
				>
					{STATUS[item.status].label}
				</Badge>
				<div className="min-w-0 flex-1">
					<div className="truncate font-mono text-small font-medium text-fg-default">
						{item.path}
					</div>
					<p className="mt-0.5 text-small leading-relaxed text-fg-subtle">
						{item.reason}
					</p>
				</div>
			</div>
			<div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-small text-fg-muted">
				<span>{ORIGIN[item.facts.origin.strength]}</span>
				<span>{INPUTS[item.facts.inputs.status]}</span>
				<span>
					{RESULT[verification.result ?? "unknown"] ?? verification.result}
				</span>
				<span>{targetLabel}</span>
			</div>
			<details className="mt-2 border-t border-border-subtle pt-1.5">
				<summary className="cursor-pointer text-small text-fg-subtle">
					查看检查依据与重验命令
				</summary>
				<div className="mt-2 space-y-2 text-small text-fg-subtle">
					<p>
						{item.evidenceStrength === "observed-origin-and-scope"
							? "来源与声明范围均有工具观察"
							: item.evidenceStrength === "declared-scope"
								? "仅有声明范围；来源未达到完整工具观察"
								: "来源或范围证据不完整"}
					</p>
					{item.facts.inputs.versions.length > 0 ? (
						<ul className="space-y-0.5 font-mono text-nano">
							{item.facts.inputs.versions.map((version) => (
								<li key={`${version.path}-${version.hash}`}>
									{version.path} @ {shortHash(version.hash)}
								</li>
							))}
						</ul>
					) : (
						<p>没有可展示的输入摘要。</p>
					)}
					{item.target.ref || item.target.currentCommit ? (
						<p className="font-mono text-nano">
							{item.target.ref ?? "目标"} · 检查{" "}
							{shortHash(item.target.checkedCommit ?? "unknown")} · 当前{" "}
							{shortHash(item.target.currentCommit ?? "unknown")}
						</p>
					) : null}
					<div className="flex min-w-0 items-start gap-2 rounded-md bg-bg-surface px-2 py-1.5">
						<code className="min-w-0 flex-1 break-all text-nano text-fg-muted">
							{item.revalidateCommand}
						</code>
						<CopyCommandButton
							copied={copied}
							onClick={copyCommand}
							path={item.path}
						/>
					</div>
					<EvidenceRefs refs={item.refs} />
				</div>
			</details>
		</li>
	);
}

function CopyCommandButton({
	copied,
	onClick,
	path,
}: {
	copied: boolean;
	onClick: () => Promise<void>;
	path: string;
}) {
	return (
		<Button
			type="button"
			variant="ghost"
			size="xs"
			className={copied ? "shrink-0 text-status-success" : "shrink-0"}
			aria-label={`复制 ${path} 的重验命令`}
			onClick={() => void onClick()}
		>
			{copied ? <Check className="size-3" /> : <Copy className="size-3" />}
			{copied ? "已复制" : "复制"}
		</Button>
	);
}

export function ResumeArtifactRows({
	projection,
}: {
	projection: ArtifactReviewProjectionView | null;
}) {
	if (!projection || projection.total === 0) return null;
	return (
		<section
			aria-label="产物检查"
			className="border-t border-border-subtle px-3 py-3"
		>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div>
					<div className="text-small font-medium text-fg-muted">
						产物检查 · {projection.total}
					</div>
					<p className="mt-0.5 text-small text-fg-subtle">
						{statusCount(projection)}
						{projection.omitted > 0
							? ` · 另有 ${projection.omitted} 项未展开`
							: ""}
					</p>
				</div>
				<span className="text-nano text-fg-subtle">
					查看或复制不会清除待重验状态
				</span>
			</div>
			<ul
				className={cn(
					"mt-2 grid gap-1.5",
					projection.items.length > 1 && "lg:grid-cols-2",
				)}
			>
				{projection.items.map((item) => (
					<ArtifactReviewRow key={item.rootId} item={item} />
				))}
			</ul>
			{projection.omitted > 0 ? (
				<p className="mt-2 text-small text-fg-subtle">
					其余 {projection.omitted} 项请用现有 CLI{" "}
					<code>checkpoint list --artifact-view</code> 查看。
				</p>
			) : null}
		</section>
	);
}
