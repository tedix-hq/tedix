import { exceptionTopology } from "./exception-topology";

type McpFailureEvent =
	| "tedi.mcp.audit_execute_failed"
	| "tedi.mcp.audit_denial_failed"
	| "tedi.mcp.api_key_usage_failed"
	| "tedi.mcp.api_key_validation_failed";

/** MCP auth/audit failures never record credential, caller or tool content. */
export function logTediMcpFailure(
	event: McpFailureEvent,
	error: unknown,
): void {
	console.error({
		component: "tedi-runtime-mcp",
		event,
		exception: exceptionTopology(error),
	});
}
