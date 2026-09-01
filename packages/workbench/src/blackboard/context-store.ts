/**
 * 上下文面的键值存储实现（TF-0098），基于接口注册表。
 *
 * 能力边界刻意写死：注册表**没有删除条目**的接口，所以回退到「原本不存在」
 * 的键会明确失败，而不是静默跳过——回退必须是可证实的动作。
 */

import type { ContextStore } from "../runtime/rollback";
import type { RegistryEntry } from "../types/interface-registry";
import type { Blackboard } from "./index";

function isRegistryEntry(value: unknown): value is RegistryEntry {
	if (!value || typeof value !== "object") {
		return false;
	}
	const v = value as Partial<RegistryEntry>;
	return typeof v.key === "string" && typeof v.contentHash === "string";
}

export function registryContextStore(bb: Blackboard): ContextStore {
	return {
		async get(key: string): Promise<unknown> {
			return bb.interfaces.getEntry(key);
		},

		async set(key: string, value: unknown): Promise<void> {
			if (!isRegistryEntry(value)) {
				throw new Error(
					`上下文回退失败：${key} 的快照不是接口注册表条目，无法写回`,
				);
			}
			const current = await bb.interfaces.getEntry(key);
			if (!current) {
				// 原本不存在（或已被删）：重新登记，恢复其内容与版本
				await bb.interfaces.register(value);
				return;
			}
			await bb.interfaces.updateVersion(key, value.contentHash, {
				expectedVersion: current.version,
			});
		},

		async remove(key: string): Promise<void> {
			throw new Error(
				`上下文回退不完整：接口注册表没有删除 ${key} 的接口，需要人工确认后处理`,
			);
		},
	};
}
