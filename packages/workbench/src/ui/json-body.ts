/**
 * Parse a JSON request body that must be an object.
 *
 * TF-0256 (F-04) introduced this for create/switch/resume-note-consume/
 * resume-card-shown, whose handlers used `request.json().catch(() => ({}))` —
 * a malformed body, an array or a bare `null` all collapsed to `{}` and the
 * route then executed its *default* action (creating an untitled thread,
 * writing an incomplete switch observation).
 *
 * TF-0261 (sweep, 2026-09-25): the first pass left three handlers still on the
 * collapsing pattern, and the sweep found each of them executing a default
 * action on a malformed body:
 *   - `restore` — `{}` passes the all-optional observation schema and appends a
 *     `thread.restored` event with empty fields (a fabricated audit fact);
 *   - `resume-note` PATCH — `{}` reaches `setResumeNote`, which persists the
 *     (unchecked) body straight into the thread meta;
 *   - `/api/tribunal/:id/shelve` — `{}` shelves the item with default minutes
 *     and answers 200.
 * The doc comment on the TF-0256 pass claimed these were "out of scope because
 * they validate a required field" — only `fork` and `resume-action` actually
 * do. A malformed or non-object body is a client error everywhere a route
 * writes: 400, and the caller short-circuits before any event or state change.
 */
export async function jsonObjectBody(
	request: Request,
): Promise<Record<string, unknown> | Response> {
	let parsed: unknown;
	try {
		parsed = await request.json();
	} catch {
		return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 });
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return Response.json({ error: "请求体必须是 JSON 对象" }, { status: 400 });
	}
	return parsed as Record<string, unknown>;
}
