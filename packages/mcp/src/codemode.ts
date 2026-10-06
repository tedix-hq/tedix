/**
 * @tedix/mcp-shared — Code Mode utilities
 *
 * Shared helpers for Code Mode availability checks. Used by both
 * apps/mcp (customer-facing MCP) and apps/tedi (tedi runtime MCP).
 *
 * @see docs/mcp/codemode.md
 */

/** Generic Code Mode can invoke authorized mutations and external providers. */
export const CODE_MODE_TOOL_ANNOTATIONS = {
	readOnlyHint: false,
	destructiveHint: true,
	openWorldHint: true,
} as const;

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
