/**
 * Server-side cursor pagination for `tools/list`.
 *
 * The aggregate surface (e.g. tedix-unified) serves hundreds of merged tools; without
 * pagination every cold `tools/list` ships the whole catalog in one payload.
 * Spec (2026-07-28, server/utilities/pagination): cursors are opaque
 * server-defined tokens, page size is server-chosen, a missing `nextCursor`
 * means end-of-results, and invalid cursors SHOULD produce -32602.
 *
 * Design: pagination runs after `sortToolsDeterministically` (stable byte-order
 * sort by tool `name`), so a name is a stable position anchor across requests.
 * The cursor is the base64 of a prefixed marker + the last served tool name;
 * the next page is every tool whose name sorts strictly after it. Surfaces at
 * or under the page size return everything with no `nextCursor` — zero
 * behavior change for plain apps.
 */

/**
 * Server-chosen page size. 200 keeps the ~700-tool aggregate at 4 pages while
 * leaving effectively every plain app (all are far below 200 tools) on the
 * single-page fast path. With typical serialized tool defs at 0.5-2 KB a page
 * stays in the low hundreds of KB — small enough to parse cheaply, large
 * enough that cursor round-trips stay rare.
 */
export const TOOLS_LIST_PAGE_SIZE = 200;

/**
 * Versioned marker inside the base64 payload. Random/foreign base64 strings
 * fail the prefix check and are rejected as invalid (-32602) instead of
 * silently acting as a name filter.
 */
const CURSOR_PAYLOAD_PREFIX = "tools-after:";

/** Opaque cursor for "the page after `lastToolName`". */
export function encodeToolsListCursor(lastToolName: string): string {
	const bytes = new TextEncoder().encode(
		`${CURSOR_PAYLOAD_PREFIX}${lastToolName}`,
	);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

/**
 * Decode a cursor back to the anchoring tool name. Returns `undefined` for
 * anything this surface did not mint (bad base64, bad UTF-8, missing prefix).
 */
export function decodeToolsListCursor(cursor: string): string | undefined {
	let decoded: string;
	try {
		const binary = atob(cursor);
		const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
		decoded = new TextDecoder("utf-8", {
			fatal: true,
			ignoreBOM: false,
		}).decode(bytes);
	} catch {
		return undefined;
	}
	if (!decoded.startsWith(CURSOR_PAYLOAD_PREFIX)) return undefined;
	return decoded.slice(CURSOR_PAYLOAD_PREFIX.length);
}

export type ToolsListPage<T> =
	| { ok: true; tools: T[]; nextCursor?: string }
	| { ok: false };

/**
 * Slice one page out of a deterministically name-sorted tools array.
 *
 * - No cursor + list fits in one page → the array as-is, no `nextCursor`.
 * - Cursor → tools whose name sorts strictly after the anchor; `nextCursor`
 *   only when more remain.
 * - Undecodable/non-string cursor → `{ ok: false }` (caller answers -32602).
 * - A list containing any entry without a string `name` cannot anchor a name
 *   cursor, so it is served whole (pagination disabled) rather than corrupted.
 */
export function paginateSortedToolsList<T>(
	tools: T[],
	cursor: unknown,
	pageSize: number = TOOLS_LIST_PAGE_SIZE,
): ToolsListPage<T> {
	const names = tools.map((tool) => (tool as { name?: unknown }).name);
	if (!names.every((name): name is string => typeof name === "string")) {
		// A cursor here is necessarily stale (we never mint one for such a
		// list); a complete un-paginated answer beats an error for the client.
		return { ok: true, tools };
	}

	let start = 0;
	if (cursor !== undefined) {
		if (typeof cursor !== "string") return { ok: false };
		const afterName = decodeToolsListCursor(cursor);
		if (afterName === undefined) return { ok: false };
		start = names.findIndex((name) => name > afterName);
		if (start === -1) return { ok: true, tools: [] };
	} else if (tools.length <= pageSize) {
		return { ok: true, tools };
	}

	const page = tools.slice(start, start + pageSize);
	const end = start + pageSize;
	if (end >= tools.length) return { ok: true, tools: page };
	return {
		ok: true,
		tools: page,
		nextCursor: encodeToolsListCursor(names[end - 1] as string),
	};
}
