import { TEDI_DURABLE_CODE_GATEWAY_TIMEOUT_MS } from "@tedix/api-contract/schemas/tedi-durable-code";
/** Resolve trusted execution budgets from the same configuration used by handlers. */
export function toolResponseTimeoutMs(
	toolName: string,
	tools: ReadonlyArray<{
		toolId: string;
		config?: Record<string, unknown> | null;
	}>,
	mcpConfig?: { codeMode?: boolean; codeModeTimeout?: number } | null,
): number | undefined {
	const timeout =
		toolName === "code" && mcpConfig?.codeMode === true
			? (mcpConfig.codeModeTimeout ?? TEDI_DURABLE_CODE_GATEWAY_TIMEOUT_MS)
			: tools.find((tool) => tool.toolId === toolName)?.config?.timeout;
	return typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0
		? timeout
		: undefined;
}
