/**
 * Bounded MCP list pagination (`tools/list`, `resources/list`, ...).
 *
 * Every MCP list cursor walk in this codebase targets a server Tedix does not
 * control, so the cursor is untrusted input. An unbounded
 * `do { … } while (cursor)` loop lets a server that returns a constant
 * nextCursor spin the caller (a Worker, a Durable Object, a CLI) until its CPU
 * limit, and one that returns tens of thousands of tools with huge JSON Schemas
 * exhaust its memory. Every walk goes through `collectBoundedMcpList` instead,
 * under explicit named bounds. MCP SDK 2.2.0 added the same page-cap and
 * repeated-cursor guards to its own `listTools()` auto-pagination.
 *
 * Runtime-neutral: no Worker, Node, or SDK types.
 */

/**
 * Independent bound for a non-terminating cursor that hands back only tiny or
 * empty pages. Tedix's own MCP edge pages at 200 entries
 * (`apps/mcp/src/mcp/tools-list-pagination.ts`) and the aggregate surface
 * serves ~700 merged tools, so 50 pages is roughly an order of magnitude of
 * headroom over the largest catalog we publish.
 */
export const MCP_LIST_MAX_PAGES = 50;

/** Retained-entry bound, independent of how many pages produced them. */
export const MCP_LIST_MAX_ITEMS = 5_000;

/**
 * Size bound, as opposed to length: descriptions and JSON Schemas are
 * server-controlled and arbitrarily large, so an entry count alone bounds
 * nothing. The collector retains everything it scans, so the scanned and
 * retained budgets are the same budget.
 */
export const MCP_LIST_MAX_BYTES = 4 * 1024 * 1024;

/**
 * A bounded catalog, and whether collecting it ran out of room.
 *
 * `truncated` is part of the return type on purpose: absence of evidence is not
 * evidence of absence. A caller that reads a cut-short catalog as a complete
 * one concludes a server lacks a tool that is merely past the cut — which is
 * how a read-only tool gets reported "unavailable" and an already-approved
 * write gets refused as "no longer exists upstream". Never derive a negative
 * from a list whose `truncated` flag is set, and cache the flag with the
 * entries whenever the entries are cached.
 */
export interface BoundedMcpList<T> {
	items: T[];
	truncated: boolean;
}

/** One list page as returned by an upstream server. */
export interface McpListPage<T> {
	items?: T[] | undefined;
	nextCursor?: unknown;
}

export interface McpListBounds {
	maxPages?: number;
	maxItems?: number;
	maxBytes?: number;
}

const listBytesEncoder = new TextEncoder();

/**
 * Walk an MCP list cursor to exhaustion or to the first bound it crosses.
 *
 * A non-string `nextCursor` ends the walk normally (a complete list): that is
 * the pre-existing contract with servers that send `null` for "no more pages".
 * An empty-string cursor is a real cursor and keeps the walk going.
 * A repeated cursor is treated as truncation rather than replayed, since it can
 * only reproduce the same page forever.
 */
export async function collectBoundedMcpList<T>(
	fetchPage: (
		cursor: string | undefined,
	) => Promise<McpListPage<T> | null | undefined>,
	bounds: McpListBounds = {},
): Promise<BoundedMcpList<T>> {
	const maxPages = bounds.maxPages ?? MCP_LIST_MAX_PAGES;
	const maxItems = bounds.maxItems ?? MCP_LIST_MAX_ITEMS;
	const maxBytes = bounds.maxBytes ?? MCP_LIST_MAX_BYTES;
	const items: T[] = [];
	const seenCursors = new Set<string>();
	let bytes = 0;
	let cursor: string | undefined;

	for (let page = 0; page < maxPages; page++) {
		const result = await fetchPage(cursor);
		const pageItems = Array.isArray(result?.items) ? result.items : [];
		for (const item of pageItems) {
			// Reported rather than inferred from `items.length`: the byte budget can
			// stop a walk well short of `maxItems` and leaves no trace in the array.
			if (items.length >= maxItems) return { items, truncated: true };
			items.push(item);
		}
		bytes += listBytesEncoder.encode(JSON.stringify(pageItems)).byteLength;
		if (bytes > maxBytes) return { items, truncated: true };
		const nextCursor = result?.nextCursor;
		// An empty string is a real cursor some servers hand out, so only a
		// non-string (absent, or the `null` servers send for "no more pages") ends
		// the walk normally.
		if (typeof nextCursor !== "string") return { items, truncated: false };
		if (seenCursors.has(nextCursor)) return { items, truncated: true };
		seenCursors.add(nextCursor);
		cursor = nextCursor;
	}
	return { items, truncated: true };
}
