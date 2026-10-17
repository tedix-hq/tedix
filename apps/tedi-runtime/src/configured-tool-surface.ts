import type { ToolSet } from "ai";

/** D1-owned exact ceiling, applied to descriptors and dispatch alike. */
export function configuredRuntimeTools(
	tools: ToolSet,
	allowed: readonly string[] | undefined,
): ToolSet {
	if (allowed === undefined) return tools;
	const names = new Set(allowed);
	return Object.fromEntries(
		Object.entries(tools).filter(([name]) => names.has(name)),
	);
}
