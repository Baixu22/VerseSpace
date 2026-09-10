/** Accept a provider base URL or an already complete endpoint pasted by a user. */
export function httpEndpoint(base: string, endpoint: string): string {
	const cleaned = base
		.trim()
		.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
		.trim();
	let url: URL;
	try {
		url = new URL(cleaned);
	} catch {
		throw new Error("模型服务 URL 无效，请填写 HTTP(S) 基址或完整端点");
	}
	if (
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password
	) {
		throw new Error("模型服务只接受不含用户名和密码的 HTTP(S) URL");
	}
	const path = url.pathname.replace(/\/+$/, "");
	const suffix =
		endpoint.startsWith("/v1/") && path.endsWith("/v1")
			? endpoint.slice(3)
			: endpoint;
	url.pathname = path.endsWith(endpoint) ? path : path + suffix;
	url.hash = "";
	return url.toString();
}
