/**
 * Server-side cursor pagination for `skills/list` (SEP-2640).
 *
 * `ListSkillsParamsSchema` has always accepted `{cursor?}`; before this module
 * the handler ignored it and shipped the whole catalog with no `nextCursor`.
 * Spec (2026-07-28, server/utilities/pagination — SEP-2640 skills
 * ride the same base-protocol list attributes): cursors are opaque
 * server-defined tokens, page size is server-chosen, a missing `nextCursor`
 * means end-of-results, and invalid cursors SHOULD produce -32602.
 *
 * Design mirrors `tools-list-pagination.ts`: the catalog is sorted by entry
 * `uri` (ascending byte order) before paginating — the skillIndex Map's
 * insertion order derives from D1 read order, which is not stable across
 * isolates, so the explicit sort is what makes a cursor a stable position
 * anchor. The cursor is the base64 of a prefixed marker + the last served
 * skill uri; the next page is every entry whose uri sorts strictly after it.
 * Catalogs at or under the page size return everything with no `nextCursor` —
 * zero behavior change for clients that never paginate, including the empty
 * catalog (`{skills: []}`).
 */

/**
 * Server-chosen page size. Skill entries are heavier than tool defs (verbatim
 * frontmatter plus a complete per-file `{uri,digest}` set), and real catalogs
 * are small — the org-library read caps at 200 rows and the instruction
 * catalog budgets 50 summaries (`server-factory.ts`), so 100 keeps effectively
 * every current surface on the single-page fast path while bounding a
 * worst-case payload to a parse-cheap page.
 */
export const SKILLS_LIST_PAGE_SIZE = 100;

/**
 * Versioned marker inside the base64 payload. Random/foreign base64 strings
 * (including a `tools/list` cursor) fail the prefix check and are rejected as
 * invalid (-32602) instead of silently acting as a uri filter.
 */
const CURSOR_PAYLOAD_PREFIX = "skills-after:";

/** Opaque cursor for "the page after `lastSkillUri`". */
export function encodeSkillsListCursor(lastSkillUri: string): string {
	const bytes = new TextEncoder().encode(
		`${CURSOR_PAYLOAD_PREFIX}${lastSkillUri}`,
	);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

/**
 * Decode a cursor back to the anchoring skill uri. Returns `undefined` for
 * anything this surface did not mint (bad base64, bad UTF-8, missing prefix).
 */
export function decodeSkillsListCursor(cursor: string): string | undefined {
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

export type SkillsListPage<T> =
	| { ok: true; skills: T[]; nextCursor?: string }
	| { ok: false };

/**
 * Sort a skills catalog by `uri` (ascending byte order), in place, and return
 * it. This is the deterministic ordering pagination anchors on; run it once at
 * registration, not per request.
 */
export function sortSkillEntriesDeterministically<T extends { uri: string }>(
	skills: T[],
): T[] {
	skills.sort((a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0));
	return skills;
}

/**
 * Slice one page out of a deterministically uri-sorted skills array.
 *
 * - No cursor + catalog fits in one page → the array as-is, no `nextCursor`.
 * - Cursor → entries whose uri sorts strictly after the anchor; `nextCursor`
 *   only when more remain.
 * - Undecodable/non-string cursor → `{ ok: false }` (caller answers -32602).
 */
export function paginateSortedSkillsList<T extends { uri: string }>(
	skills: T[],
	cursor: unknown,
	pageSize: number = SKILLS_LIST_PAGE_SIZE,
): SkillsListPage<T> {
	let start = 0;
	if (cursor !== undefined) {
		if (typeof cursor !== "string") return { ok: false };
		const afterUri = decodeSkillsListCursor(cursor);
		if (afterUri === undefined) return { ok: false };
		start = skills.findIndex((skill) => skill.uri > afterUri);
		if (start === -1) return { ok: true, skills: [] };
	} else if (skills.length <= pageSize) {
		return { ok: true, skills };
	}

	const page = skills.slice(start, start + pageSize);
	const end = start + pageSize;
	if (end >= skills.length) return { ok: true, skills: page };
	return {
		ok: true,
		skills: page,
		nextCursor: encodeSkillsListCursor((skills[end - 1] as T).uri),
	};
}
