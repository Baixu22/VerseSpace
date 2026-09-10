import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2 } from "lucide-react";
import { useState } from "react";
import { apiFetch } from "../../auth";
import { type ChatConfig, chatConfigQuery } from "../../chat/config";
import { Button } from "../ui/button";
import { SettingsFields } from "./settings-fields";

export function SettingsPanel() {
	const query = useQuery(chatConfigQuery);
	const client = useQueryClient();
	const [draft, setDraft] = useState<Partial<ChatConfig>>({});
	const save = useMutation({
		// Blur and selection changes can overlap; preserve their ordering.
		scope: { id: "chat-config" },
		mutationFn: async (body: Partial<ChatConfig>): Promise<ChatConfig> => {
			const response = await apiFetch("/api/config/chat", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!response.ok) throw new Error("保存失败，你的输入已保留。请重试。");
			return response.json();
		},
		onSuccess: (saved, body) => {
			client.setQueryData(chatConfigQuery.queryKey, saved);
			setDraft((current) => {
				const next = { ...current };
				for (const key of Object.keys(body) as (keyof ChatConfig)[]) {
					if (current[key] === body[key]) delete next[key];
				}
				return next;
			});
		},
	});
	const patch = (body: Partial<ChatConfig>) => {
		const changed = Object.fromEntries(
			Object.entries(body).filter(
				([key, value]) =>
					value !== undefined &&
					value !== query.data?.[key as keyof ChatConfig] &&
					!(value === "" && query.data?.[key as keyof ChatConfig] == null) &&
					!(
						save.isPending && value === save.variables[key as keyof ChatConfig]
					),
			),
		) as Partial<ChatConfig>;
		if (Object.keys(changed).length === 0) return;
		setDraft((current) => ({ ...current, ...changed }));
		save.mutate(changed);
	};

	return (
		<>
			<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-6">
				{query.data ? (
					<SettingsFields
						config={{ ...query.data, ...draft }}
						onChange={(body) =>
							setDraft((current) => ({ ...current, ...body }))
						}
						onSave={patch}
					/>
				) : query.isError ? (
					<div role="alert" className="space-y-3 text-small text-status-danger">
						<p>{query.error.message}</p>
						<Button variant="outline" onClick={() => void query.refetch()}>
							重新加载
						</Button>
					</div>
				) : (
					<p role="status" className="text-small text-fg-muted">
						正在加载设置…
					</p>
				)}
			</div>
			<div className="flex min-h-14 shrink-0 items-center gap-2 border-t border-border-subtle px-5 py-3 text-small text-fg-muted">
				{save.isError ? (
					<>
						<span role="alert" className="flex-1 text-status-danger">
							{save.error.message}
						</span>
						<Button
							variant="outline"
							size="sm"
							onClick={() => save.mutate(save.variables)}
						>
							重试
						</Button>
					</>
				) : (
					<span role="status" className="inline-flex items-center gap-2">
						{save.isPending ? (
							<Loader2 className="size-3.5 animate-spin" />
						) : save.isSuccess ? (
							<Check className="size-3.5 text-status-success" />
						) : null}
						{save.isPending
							? "正在保存…"
							: save.isSuccess
								? "已保存"
								: "修改后自动保存"}
					</span>
				)}
			</div>
		</>
	);
}
