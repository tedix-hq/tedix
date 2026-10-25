/**
 * One audit shape for every MCP gate decision, so any allow or deny can be
 * explained from the audit row alone: which gate decided, what it decided,
 * and why. Each gate keeps its own detail fields next to these three.
 */
export type McpGate =
	| "edge_access"
	| "tool_scope"
	| "risk_rate_limit"
	| "annotation_assertion"
	| "destructive_approval";

export type McpGateDecision = "allow" | "deny";

export interface McpGateDecisionMetadata {
	gate: McpGate;
	gateDecision: McpGateDecision;
	gateReason: string;
	[key: string]: string;
}

export function gateDecisionMetadata(
	gate: McpGate,
	gateDecision: McpGateDecision,
	gateReason: string,
): McpGateDecisionMetadata {
	return { gate, gateDecision, gateReason };
}
