import { inputObservationSchema } from "./session-types";
import type { FootprintUsed } from "./sessions";

export function claimStrength(
	claim: Pick<FootprintUsed, "version" | "size">,
): "content-hash" | "size-only" | "unknown" {
	return claim.version != null
		? "content-hash"
		: claim.size !== undefined
			? "size-only"
			: "unknown";
}

/** Size-only versions preserve the capture cap; equal-size edits remain unobservable. */
export function claimVersion(
	claim: Pick<FootprintUsed, "version" | "size">,
): string | null {
	return (
		claim.version ?? (claim.size === undefined ? null : `size:${claim.size}`)
	);
}

/** Source evidence is independent of the legacy premise-strength projection. */
export function claimObservation(claim: FootprintUsed) {
	const parsed = inputObservationSchema.safeParse(claim.observation);
	if (!parsed.success)
		return {
			source: "unknown" as const,
			binding: "unknown" as const,
			reason:
				claim.size !== undefined
					? "size-only，不包含可核对的返回内容"
					: "旧日志缺少观察来源或字段无效",
		};
	const observation = parsed.data;
	if (observation.source === "unknown")
		return {
			source: "unknown" as const,
			binding: "unknown" as const,
			reason: observation.reason,
		};
	if (observation.source === "declared")
		return {
			source: "declared" as const,
			binding: "unknown" as const,
			contentHash: observation.contentHash,
			reason: "调用者声明，不是工具观察",
		};
	if (observation.source === "fs-sample") {
		return observation.sample.stable &&
			observation.sample.version === claim.version
			? {
					source: "fs-sample" as const,
					binding: "unknown" as const,
					reason: "稳定文件采样，未绑定工具返回内容",
				}
			: {
					source: "unknown" as const,
					binding: "unknown" as const,
					reason: "文件采样变化或版本关联不一致",
				};
	}
	const selector = observation.selector;
	if (
		selector.kind === "lines" &&
		(claim.span?.start !== selector.start || claim.span?.end !== selector.end)
	)
		return {
			source: "unknown" as const,
			binding: "unknown" as const,
			reason: "返回范围与足迹读取范围不一致",
		};
	if (
		selector.kind === "file" &&
		claim.span &&
		(claim.span.start !== 1 || claim.span.end !== Number.MAX_SAFE_INTEGER)
	)
		return {
			source: "unknown" as const,
			binding: "unknown" as const,
			reason: "全文件返回声明与片段足迹不一致",
		};
	const sample = observation.sample;
	const binding =
		!sample?.stable || sample.version !== claim.version
			? ("unknown" as const)
			: sample.contentHash === observation.contentHash
				? ("matched" as const)
				: ("different" as const);
	return {
		source: "tool-observed" as const,
		binding,
		contentHash: observation.contentHash,
		returnedHash: observation.returnedHash,
		selector: observation.selector,
		normalization: observation.normalization,
		reason:
			binding === "matched"
				? "返回内容与稳定采样的选择范围一致"
				: binding === "different"
					? "返回内容不同于采集文件版本"
					: "工具内容已记录，文件版本关联未知",
	};
}
