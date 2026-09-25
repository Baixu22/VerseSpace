import type { Blackboard } from "../blackboard";

import { jsonObjectBody } from "./json-body";

/**
 * The tribunal queue in the chat surface (TF-0242).
 *
 * The queue is global to the ledger, not scoped to a thread — so these routes
 * live at `/api/tribunal`, not under a conversation. They are the first
 * write-capable ledger action reachable from the dashboard: resolve and shelve
 * go through the SAME `bb.tribunal` API the `workbench tribunal` CLI uses, so
 * the `tribunal_resolved` / `tribunal_shelved` events are indistinguishable
 * from a CLI decision. Reads stay read-only; nothing here mutates a chat
 * transcript (the append-only / KV-cache red line stays intact).
 */
export async function tribunalRoute(
	bb: Blackboard,
	url: URL,
	request: Request,
): Promise<Response | null> {
	if (url.pathname === "/api/tribunal" && request.method === "GET") {
		// Pending + shelved, never resolved: the bar shows what still owes a
		// decision. Sorted by score so the loudest item is first.
		const items = (await bb.tribunal.list())
			.filter((item) => item.state !== "resolved")
			.sort((a, b) => b.score - a.score);
		// Unreadable files ride along with the list: a queue the store could not
		// fully parse must not be served as if it were simply empty. `items`
		// keeps its shape, so the dashboard bar is unaffected.
		const unreadable = await bb.tribunal.unreadable();
		return Response.json({ items, unreadable });
	}

	const match = url.pathname.match(
		/^\/api\/tribunal\/([^/]+)\/(resolve|shelve)$/,
	);
	if (!match) {
		return null;
	}
	if (request.method !== "POST") {
		return null;
	}
	let id: string;
	try {
		id = decodeURIComponent(match[1] ?? "");
	} catch {
		return Response.json({ error: "裁决项标识无效" }, { status: 400 });
	}
	if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
		return Response.json({ error: "裁决项标识无效" }, { status: 400 });
	}
	const action = match[2];

	if (action === "resolve") {
		const item = await bb.tribunal.resolve(id);
		if (!item) {
			return Response.json(
				{ ok: false, reason: "裁决项不存在或已裁决" },
				{ status: 404 },
			);
		}
		return Response.json({ ok: true, item });
	}

	// shelve: optional minutes; the API clamps to [MIN, MAX] itself.
	// TF-0261 sweep: `.catch(() => ({}))` made a malformed body indistinguishable
	// from the `{}` the UI sends for "shelve with defaults", so a truncated
	// request shelved the item and answered 200. Reject the body first.
	const body = await jsonObjectBody(request);
	if (body instanceof Response) return body;
	const item = await bb.tribunal.shelve(
		id,
		typeof body.minutes === "number" ? body.minutes : undefined,
	);
	if (!item) {
		return Response.json(
			{ ok: false, reason: "裁决项不存在或已裁决" },
			{ status: 404 },
		);
	}
	return Response.json({ ok: true, item });
}
