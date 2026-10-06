import { unwrapCallToolResult } from "@tedix/mcp-shared/tool-result";

export type WidgetMcpContent = Array<{
	type: string;
	text?: string;
	[key: string]: unknown;
}>;

export interface WidgetMcpToolResult {
	content: WidgetMcpContent;
	data: Record<string, unknown>;
}

export function normalizeWidgetMcpToolResult(
	rawResult: Record<string, unknown>,
	toolName: string,
): WidgetMcpToolResult {
	const content = Array.isArray(rawResult.content)
		? (rawResult.content as WidgetMcpContent)
		: [];
	const normalized = unwrapCallToolResult(rawResult, toolName);
	const data =
		normalized !== null &&
		typeof normalized === "object" &&
		!Array.isArray(normalized)
			? (normalized as Record<string, unknown>)
			: {};

	return { content, data };
}
