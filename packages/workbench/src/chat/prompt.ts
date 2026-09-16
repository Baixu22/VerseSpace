export function turnLine(text: string): string {
	// `--input-format stream-json` is newline-delimited. Keeping the delimiter
	// on every frame matters when a persistent session receives more than one
	// turn; without it, two writes can be buffered as one invalid JSON value.
	return `${JSON.stringify({
		type: "user",
		message: { role: "user", content: text },
	})}\n`;
}

export function promptWithNotices(text: string, notices: string[]): string {
	if (notices.length === 0) {
		return text;
	}
	return [
		"[Workbench 前提通知；先核对事实，再处理当前请求]",
		notices.join("\n\n"),
		"[当前用户请求]",
		text,
	].join("\n\n");
}
