import type { ToolSet } from "ai";

/**
 * A scheduled recurring turn receives one model-visible capability: Tedix
 * Unified Code Mode. The cron prompt already requires Code Mode, whose runtime
 * can discover and call the full governed MCP surface (including Work Items,
 * PromptWatch, Firecrawl, and CMS writes). Repeating every native workspace,
 * browser, storage, durable-code, and convenience schema on each provider call
 * adds tens of thousands of stable input tokens without adding authority.
 */
const CRON_FACET_TOOL_NAMES = new Set(["tedix_mcp_code"]);
function projectFacetTools(
	tools: ToolSet,
	names: ReadonlySet<string>,
): ToolSet {
	const projected: ToolSet = {};
	for (const [name, definition] of Object.entries(tools)) {
		if (names.has(name)) projected[name] = definition;
	}
	return projected;
}

export function cronFacetToolSurface(tools: ToolSet): ToolSet {
	return projectFacetTools(tools, CRON_FACET_TOOL_NAMES);
}
