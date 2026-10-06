import { unwrapCallToolResult } from "@tedix/mcp-shared/tool-result";

type CmsToolResult = {
	content: Array<{ type: "text"; text: string }>;
	structuredContent?: unknown;
	isError?: true;
	_meta?: { code?: string; details?: unknown; [key: string]: unknown };
};

/** CMS-owned callers use the platform's single MCP result normalization path. */
export function unwrapCmsToolResult(
	result: CmsToolResult,
	operation: string,
): unknown {
	return unwrapCallToolResult(result, operation);
}
