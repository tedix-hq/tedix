/**
 * Unwrap MCP CallToolResult to plain value.
 *
 * Delegates to the shared `@tedix/mcp-shared/tool-result` pipeline — the SAME
 * normalization skill-runtime's env.MCP bridge uses — so a tool result can
 * never take a different shape depending on which surface called it (the
 * codemode-vs-skill-runtime shape-mismatch class). This also adds
 * `input_required` detection this copy previously lacked: a gateway-halted
 * approval now throws instead of flowing through as prose.
 */

import { unwrapCallToolResult } from "@tedix/mcp-shared/tool-result";

export function unwrapMcpResult(
	result: Record<string, unknown>,
	toolName = "codemode.connector",
): unknown {
	return unwrapCallToolResult(result, toolName);
}
