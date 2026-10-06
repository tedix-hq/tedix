/**
 * Deterministic tools/list ordering for prompt-cache hits.
 *
 * D1 load order and aggregate merging are not stable across requests, so
 * without a canonical sort the served tool list permutes between requests and
 * busts client prompt caches keyed on the tool definitions. Sorting by tool
 * `name` gives a stable, request-independent order.
 */

/**
 * Sort a tools/list array in place by tool `name` (ascending, byte order).
 * Entries without a string `name` retain their relative position
 * (Array.prototype.sort is stable). Returns the same array for chaining.
 */
export function sortToolsDeterministically<T>(tools: T[]): T[] {
	tools.sort((a, b) => {
		const an = (a as { name?: unknown }).name;
		const bn = (b as { name?: unknown }).name;
		if (typeof an !== "string" || typeof bn !== "string") return 0;
		return an < bn ? -1 : an > bn ? 1 : 0;
	});
	return tools;
}
