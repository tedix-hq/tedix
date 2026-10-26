import type { AppTool } from "./server-context";
import type { CatalogToolEntry } from "./codemode-catalog-entries";

// Snapshot rows are replaced when aggregate resolution refreshes its revision.
// Weak keys let the existing surface caches own their lifetime and invalidation.
const sources = new WeakMap<AppTool, AppTool>();
interface Projection {
	namespace: string;
	safeName: string;
	description: string | null;
	entry: CatalogToolEntry;
}
const projections = new WeakMap<AppTool, Projection[]>();

export function copyCatalogTool(tool: AppTool): AppTool {
	const copy = {
		...tool,
		config: tool.config ? { ...tool.config } : tool.config,
	};
	sources.set(copy, tool);
	return copy;
}

/** Only pure descriptors belong here; never cache caller decisions or handlers. */
export function cachedCatalogProjection(
	tool: AppTool,
	namespace: string,
	safeName: string,
	build: () => CatalogToolEntry,
): CatalogToolEntry {
	const source = sources.get(tool);
	// Ad hoc contexts can mutate their rows. Only factory copies have an immutable
	// source snapshot whose identity acts as a catalog revision.
	if (!source) return build();
	const entries = projections.get(source) ?? [];
	const hit = entries.find(
		(entry) =>
			entry.namespace === namespace &&
			entry.safeName === safeName &&
			entry.description === tool.description,
	);
	if (hit) return hit.entry;
	const entry = build();
	// Keep string references rather than duplicating vendor descriptions in keys.
	// Different tedi skill summaries can enrich the same source row differently.
	if (entries.length >= 2) entries.shift();
	entries.push({ namespace, safeName, description: tool.description, entry });
	projections.set(source, entries);
	return entry;
}
