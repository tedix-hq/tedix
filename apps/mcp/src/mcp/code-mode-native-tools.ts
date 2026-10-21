/**
 * The session Code Mode lane's home-surface tool ids listed beside `code`.
 * The stateless fast path (`compactCodeModeTools` in index.ts) never lists
 * `ask`: it creates a durable Home turn and requires an authenticated org
 * context the stateless lane does not resolve. The outer-surface lane
 * conformance test pins both lists to this decision.
 */
export const SESSION_NATIVE_HOME_TOOL_IDS = ["ask"] as const;

/**
 * Code Mode apps list `code` as their only top-level tool by default. The
 * session-native `ask` and configured catalog rows keep their own explicit
 * decisions; any other tool (bootstrap `get_info`/`get_profile`, skill
 * helpers, MCP App widget tools such as `show_deck`) is listed only when its
 * exact registered name is in `mcpConfig.codeModeNativeTools`. Unlisted
 * bootstrap tools stay callable for existing clients, and every tool stays
 * reachable as a Code Mode callable.
 */
export function isCodeModeNativeOptIn(
	mcpConfig: Record<string, unknown> | null | undefined,
	toolName: string,
): boolean {
	const names = mcpConfig?.codeModeNativeTools;
	return Array.isArray(names) && names.includes(toolName);
}
