/**
 * @tedix/mcp-shared — Code Mode utilities
 *
 * Shared helpers for Code Mode availability checks. Used by both
 * apps/mcp (customer-facing MCP) and apps/tedi (tedi runtime MCP).
 *
 * @see docs/engineering/mcp/codemode.md
 */

/** Generic Code Mode can invoke authorized mutations and external providers. */
export const CODE_MODE_TOOL_ANNOTATIONS = {
	readOnlyHint: false,
	destructiveHint: true,
	openWorldHint: true,
} as const;

export const CHATGPT_CODE_DESCRIPTION =
	"Execute JavaScript to read or manage Work items, create and update Workspace outputs such as documents, sheets and slides, find and run skills, run tedi turns, and read or act through connected providers within your granted permissions. First use the `search` tool to find the exact callable and its schema. Call the returned callable exactly. Operations remain subject to authorization and approval policies.";

export const CHATGPT_SEARCH_ANNOTATIONS = {
	readOnlyHint: true,
	destructiveHint: false,
	openWorldHint: false,
} as const;

export const CHATGPT_SEARCH_DESCRIPTION =
	"Search Tedix operations by keyword. Returns matching operation callables with full descriptions and input schemas, without executing them. Use the exact callable and schema with the code tool.";

// Host identification selects presentation only; it never grants access.
export function isChatGptConnection(
	appSlug: string,
	headers: Headers,
	meta?: Record<string, unknown>,
): boolean {
	if (appSlug !== "connect") return false;
	const info = meta?.["io.modelcontextprotocol/clientInfo"];
	const name =
		info && typeof info === "object" && "name" in info ? info.name : undefined;
	return (
		/^https:\/\/chatgpt\.com\/oauth\/(?:[A-Za-z0-9_-]+\/)?client\.json$/.test(
			headers.get("x-tedix-auth-client-id") ?? "",
		) ||
		(typeof name === "string" &&
			/^(?:chatgpt|openai-mcp)(?:[ /-]|$)/i.test(name)) ||
		/^(?:ChatGPT|openai-mcp)(?:[ /]|$)/i.test(headers.get("user-agent") ?? "")
	);
}

// =============================================================================
// AVAILABILITY CHECK
// =============================================================================

/**
 * Check if Code Mode is available (LOADER binding exists).
 *
 * The LOADER binding is a WorkerLoader service binding injected by
 * the DynamicWorkerExecutor infrastructure. When absent, callers
 * should fall back to standard tool registration.
 */
export function isCodeModeAvailable(env: Record<string, unknown>): boolean {
	return "LOADER" in env && env.LOADER != null;
}
