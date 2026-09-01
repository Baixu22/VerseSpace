/**
 * Workbench UI server requires a per-run token on every /api request
 * (x-workbench-token). The SPA fetches it once from the /api/bootstrap
 * handshake — readable only same-origin, so cross-site pages can't get it.
 * On a 401 the server was likely restarted with a fresh token: re-handshake
 * once before giving up.
 */
let tokenPromise: Promise<string> | null = null;

function requestToken(): Promise<string> {
	return fetch("/api/bootstrap")
		.then((response) => {
			if (!response.ok) {
				throw new Error(`/api/bootstrap ${response.status}`);
			}
			return response.json() as Promise<{ token: string }>;
		})
		.then((body) => body.token);
}

export function apiToken(): Promise<string> {
	tokenPromise ??= requestToken();
	return tokenPromise;
}

function resetToken(): void {
	tokenPromise = null;
}

export async function apiFetch(
	input: string,
	init?: RequestInit,
): Promise<Response> {
	const send = (token: string) => {
		const headers = new Headers(init?.headers);
		headers.set("x-workbench-token", token);
		return fetch(input, { ...init, headers });
	};
	let response = await send(await apiToken());
	if (response.status === 401) {
		resetToken();
		response = await send(await apiToken());
	}
	return response;
}
