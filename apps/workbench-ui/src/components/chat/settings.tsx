import { useEffect, useState } from "react";
import { apiFetch } from "../../auth";
import { Button } from "../ui/button";

export interface ChatConfig {
	provider: "claude" | "openai-chat" | "openai-responses" | "anthropic";
	model?: string;
	apiKey?: string;
	baseUrl?: string;
	temperature?: number;
	maxTokens?: number;
	effort?: "low" | "medium" | "high";
	hasKey?: boolean;
}

const PROVIDERS: Array<{
	value: ChatConfig["provider"];
	label: string;
	hint: string;
}> = [
	{
		value: "claude",
		label: "Claude Code CLI（本机）",
		hint: "stream-json + 会话续聊，无需 API Key",
	},
	{
		value: "openai-chat",
		label: "OpenAI · Chat Completions",
		hint: "流式 SSE，需 API Key",
	},
	{
		value: "openai-responses",
		label: "OpenAI · Responses",
		hint: "支持推理力度（effort）控制",
	},
	{
		value: "anthropic",
		label: "Anthropic · Messages",
		hint: "流式 SSE，需 API Key",
	},
];

export function SettingsPanel({ onClose }: { onClose: () => void }) {
	const [config, setConfig] = useState<ChatConfig | null>(null);
	const [note, setNote] = useState<string | null>(null);

	useEffect(() => {
		void apiFetch("/api/config/chat")
			.then((r) => r.json() as Promise<ChatConfig>)
			.then(setConfig);
	}, []);

	const patch = async (body: Partial<ChatConfig>) => {
		const saved = await apiFetch("/api/config/chat", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}).then((r) => r.json() as Promise<ChatConfig>);
		setConfig(saved);
		setNote("已保存");
		setTimeout(() => setNote(null), 1200);
	};

	const field =
		"w-full rounded-lg border border-input bg-input/30 px-2.5 py-1.5 text-small outline-none focus-visible:border-ring";
	const label = "text-small text-fg-muted";

	return (
		<div className="fixed inset-0 z-30 flex justify-end bg-black/40">
			<div className="flex h-full w-[380px] flex-col border-l border-border bg-bg-surface">
				<div className="flex items-center gap-2 border-b border-border px-4 py-3">
					<span className="text-title font-semibold">对话设置</span>
					<Button
						size="xs"
						variant="ghost"
						className="ml-auto"
						onClick={onClose}
					>
						关闭
					</Button>
				</div>
				{!config ? (
					<p className="p-4 text-small text-fg-muted">加载中…</p>
				) : (
					<div className="flex-1 space-y-4 overflow-y-auto p-4">
						<div>
							<p className={label}>提供商</p>
							<select
								className={field}
								value={config.provider}
								onChange={(e) =>
									void patch({
										provider: e.target.value as ChatConfig["provider"],
									})
								}
							>
								{PROVIDERS.map((p) => (
									<option key={p.value} value={p.value}>
										{p.label}
									</option>
								))}
							</select>
							<p className="mt-1 text-micro text-fg-subtle">
								{PROVIDERS.find((p) => p.value === config.provider)?.hint}
							</p>
						</div>

						<div>
							<p className={label}>模型（留空用提供商默认）</p>
							<input
								className={field}
								value={config.model ?? ""}
								placeholder={
									config.provider === "anthropic"
										? "claude-sonnet-4-5"
										: config.provider === "claude"
											? "（跟随本机登录）"
											: "gpt-4o-mini"
								}
								onChange={(e) =>
									setConfig({ ...config, model: e.target.value })
								}
								onBlur={() => void patch({ model: config.model || undefined })}
							/>
						</div>

						{config.provider !== "claude" ? (
							<div>
								<p className={label}>
									API Key{config.hasKey ? "（已保存，留空不变）" : ""}
								</p>
								<input
									type="password"
									className={field}
									value={config.apiKey ?? ""}
									onChange={(e) =>
										setConfig({ ...config, apiKey: e.target.value })
									}
									onBlur={() =>
										void patch({ apiKey: config.apiKey || undefined })
									}
								/>
							</div>
						) : null}

						{config.provider !== "claude" ? (
							<div>
								<p className={label}>Base URL（可选，代理/网关）</p>
								<input
									className={field}
									value={config.baseUrl ?? ""}
									placeholder={
										config.provider === "anthropic"
											? "https://api.anthropic.com"
											: "https://api.openai.com/v1"
									}
									onChange={(e) =>
										setConfig({ ...config, baseUrl: e.target.value })
									}
									onBlur={() =>
										void patch({ baseUrl: config.baseUrl || undefined })
									}
								/>
							</div>
						) : null}

						{config.provider !== "claude" ? (
							<div>
								<p className={label}>
									温度（temperature）：{config.temperature ?? 1}
								</p>
								<input
									type="range"
									min={0}
									max={2}
									step={0.1}
									value={config.temperature ?? 1}
									className="w-full"
									onChange={(e) =>
										setConfig({
											...config,
											temperature: Number(e.target.value),
										})
									}
									onMouseUp={() =>
										void patch({ temperature: config.temperature ?? 1 })
									}
									onTouchEnd={() =>
										void patch({ temperature: config.temperature ?? 1 })
									}
								/>
							</div>
						) : null}

						{config.provider !== "claude" ? (
							<div>
								<p className={label}>最大输出 Token</p>
								<input
									type="number"
									min={64}
									className={field}
									value={config.maxTokens ?? ""}
									placeholder={
										config.provider === "anthropic"
											? "1024（必填默认）"
											: "不限制"
									}
									onChange={(e) =>
										setConfig({
											...config,
											maxTokens: Number(e.target.value) || undefined,
										})
									}
									onBlur={() => void patch({ maxTokens: config.maxTokens })}
								/>
							</div>
						) : null}

						{config.provider === "openai-responses" ? (
							<div>
								<p className={label}>推理力度（reasoning effort）</p>
								<select
									className={field}
									value={config.effort ?? ""}
									onChange={(e) =>
										void patch({
											effort: (e.target.value ||
												undefined) as ChatConfig["effort"],
										})
									}
								>
									<option value="">默认</option>
									<option value="low">low</option>
									<option value="medium">medium</option>
									<option value="high">high</option>
								</select>
							</div>
						) : null}

						<p className="text-micro text-fg-subtle">
							配置存于 .workbench/workbench.yaml（本机文件）。API Key
							仅存本地，接口永不下发明文。
						</p>
					</div>
				)}
				<div className="border-t border-border px-4 py-2 text-small text-status-success">
					{note}
				</div>
			</div>
		</div>
	);
}
