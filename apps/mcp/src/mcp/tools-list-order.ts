/**
 * Deterministic tools/list ordering for prompt-cache hits.
 *
 * D1 load order and aggregate merging are not stable across requests, so
 * without a canonical sort the served tool list permutes between requests and
 * busts client prompt caches keyed on the tool definitions. Sorting by tool
 * `name` gives a stable, request-independent order.
 */

/**
 * Sort string-named entries in place (ascending UTF-16 code-unit order).
 * Entries without a string `name` stay in their original slots; equal names
 * retain their input order. Returns the same array for chaining.
 */
export function sortToolsDeterministically<T>(tools: T[]): T[] {
	const named = tools.filter(
		(tool) => typeof (tool as { name?: unknown }).name === "string",
	);
	named.sort((a, b) => {
		const an = (a as { name: string }).name;
		const bn = (b as { name: string }).name;
		return an < bn ? -1 : an > bn ? 1 : 0;
	});
	let next = 0;
	for (let index = 0; index < tools.length; index++) {
		if (typeof (tools[index] as { name?: unknown }).name === "string") {
			tools[index] = named[next++]!;
		}
	}
	return tools;
}
