export interface DurableCodePendingAction {
	args: unknown;
	connector: string;
	executionId: string;
	method: string;
	seq: number;
}

export interface DurableCodePause {
	executionId: string;
	pending: DurableCodePendingAction[];
}

export interface DurableCodeRunCorrelation {
	approvalRequestId?: string;
	approvalPendingSeq?: number;
	codeHash?: string;
	conversationId: string;
	homeRunId?: string;
	runId: string;
	sessionKey: string;
	workItemId?: string;
}

export function durableCodeCorrelationKey(executionId: string): string {
	return `durable-code:correlation:${executionId}`;
}

export function tediMcpConnectorInstructions(): string {
	return [
		"Tedix-assigned MCP apps for this tedi.",
		"The mcp global is proxy-backed: Object.keys(mcp) is empty and is not a discovery mechanism.",
		"Call mcp.list_namespaces({}) and mcp.search_tools({ query }) directly, then use mcp.call_tool(...) for a selected tool.",
		"There is no discover namespace inside this durable runtime; do not call discover.* or mcp.discover.*.",
		"call_tool is approval-gated because it can dispatch either reads or writes; approval is tied to the exact recorded arguments.",
	].join(" ");
}
