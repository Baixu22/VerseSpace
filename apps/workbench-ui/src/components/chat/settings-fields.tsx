import type { ChatConfig } from "../../chat/config";
import { Select } from "../ui/select";

const PROVIDERS = [
	{
		value: "claude",
		label: "Claude Code · 本机",
		description: "使用本机登录信息，无需 API Key。",
	},
	{
		value: "openai-chat",
		label: "OpenAI · Chat Completions",
		description: "支持 OpenAI 及兼容服务。",
	},
	{
		value: "openai-responses",
		label: "OpenAI · Responses",
		description: "支持推理力度与 Responses 接口。",
	},
	{
		value: "anthropic",
		label: "Anthropic · Messages",
		description: "通过 Anthropic 接口使用 Claude。",
	},
] as const;

const EFFORTS = [
	{ value: "default", label: "默认", description: "由提供商决定推理力度。" },
	{ value: "low", label: "低", description: "优先响应速度，适合简单问题。" },
	{ value: "medium", label: "中", description: "兼顾响应速度与分析深度。" },
	{ value: "high", label: "高", description: "更充分地思考，适合复杂问题。" },
] as const;

export function SettingsFields({
	config,
	onChange,
	onSave,
}: {
	config: ChatConfig;
	onChange: (body: Partial<ChatConfig>) => void;
	onSave: (body: Partial<ChatConfig>) => void;
}) {
	const label = "mb-2 block text-ui font-medium text-fg-default";
	const hint = "mt-2 text-small leading-relaxed text-fg-muted";
	return (
		<div className="space-y-6">
			<div>
				<label htmlFor="chat-provider" className={label}>
					提供商
				</label>
				<Select
					id="chat-provider"
					value={config.provider}
					options={PROVIDERS}
					describedBy="chat-provider-description"
					onValueChange={(value) =>
						onSave({ provider: value as ChatConfig["provider"] })
					}
				/>
				<p id="chat-provider-description" className={hint}>
					{
						PROVIDERS.find((provider) => provider.value === config.provider)
							?.description
					}
				</p>
			</div>
			<div>
				<label htmlFor="chat-model" className={label}>
					模型
				</label>
				<input
					id="chat-model"
					className="ui-field"
					value={config.model ?? ""}
					placeholder="使用提供商默认模型"
					onChange={(event) => onChange({ model: event.target.value })}
					onBlur={() => onSave({ model: config.model ?? "" })}
				/>
				<p className={hint}>留空使用默认模型，也可以输入完整的模型名称。</p>
			</div>
			{config.provider !== "claude" ? (
				<>
					<div>
						<label htmlFor="chat-key" className={label}>
							API Key
						</label>
						<input
							id="chat-key"
							type="password"
							autoComplete="off"
							className="ui-field"
							value={config.apiKey ?? ""}
							placeholder={
								config.hasKey ? "已配置 · 留空保持不变" : "输入 API Key"
							}
							onChange={(event) => onChange({ apiKey: event.target.value })}
							onBlur={() => {
								if (config.apiKey) onSave({ apiKey: config.apiKey });
							}}
						/>
					</div>
					<div>
						<label htmlFor="chat-base-url" className={label}>
							Base URL <span className="font-normal text-fg-muted">· 可选</span>
						</label>
						<input
							id="chat-base-url"
							className="ui-field"
							value={config.baseUrl ?? ""}
							spellCheck={false}
							placeholder={
								config.provider === "anthropic"
									? "https://api.anthropic.com"
									: "https://api.openai.com/v1"
							}
							onChange={(event) => onChange({ baseUrl: event.target.value })}
							onBlur={() => onSave({ baseUrl: config.baseUrl ?? "" })}
						/>
						<p className={hint}>使用代理或兼容服务时，填写对应的接口地址。</p>
					</div>
					<div className="border-t border-border-subtle pt-6">
						<label
							htmlFor="chat-temperature"
							className={`${label} flex items-center justify-between`}
						>
							温度{" "}
							<span className="font-mono text-fg-muted">
								{config.temperature ?? 1}
							</span>
						</label>
						<input
							id="chat-temperature"
							type="range"
							min={0}
							max={2}
							step={0.1}
							value={config.temperature ?? 1}
							className="w-full cursor-pointer accent-primary"
							onChange={(event) =>
								onChange({ temperature: Number(event.target.value) })
							}
							onPointerUp={() =>
								onSave({ temperature: config.temperature ?? 1 })
							}
							onKeyUp={() => onSave({ temperature: config.temperature ?? 1 })}
							onBlur={() => onSave({ temperature: config.temperature ?? 1 })}
						/>
						<p className={hint}>较低的值更稳定，较高的值更有变化。</p>
					</div>
					<div>
						<label htmlFor="chat-max-tokens" className={label}>
							最大输出 Token
						</label>
						<input
							id="chat-max-tokens"
							type="number"
							min={64}
							className="ui-field"
							value={config.maxTokens ?? ""}
							placeholder={
								config.provider === "anthropic"
									? "默认 1024"
									: "使用提供商默认值"
							}
							onChange={(event) =>
								onChange({ maxTokens: Number(event.target.value) || undefined })
							}
							onBlur={() => onSave({ maxTokens: config.maxTokens })}
						/>
					</div>
				</>
			) : null}
			{config.provider === "openai-responses" ? (
				<div>
					<label htmlFor="chat-effort" className={label}>
						推理力度
					</label>
					<Select
						id="chat-effort"
						value={config.effort ?? "default"}
						options={EFFORTS}
						onValueChange={(value) =>
							onSave({
								effort:
									value === "default" ? null : (value as ChatConfig["effort"]),
							})
						}
					/>
				</div>
			) : null}
			<p className="rounded-lg bg-bg-base px-3 py-3 text-small leading-relaxed text-fg-muted">
				设置保存在本机。已保存的 API Key 不会在页面中显示。
			</p>
		</div>
	);
}
