export const MCP_SLO_LANES = [
	"auth",
	"discovery",
	"hydration",
	"tool_execution",
	"audit",
	"runtime",
	"task",
	"subscription",
	"trace",
] as const;

export type McpSloLane = (typeof MCP_SLO_LANES)[number];

export interface McpSloDefinition {
	lane: McpSloLane;
	owner: string;
	canary: string;
	evidenceSource:
		| "analytics_engine"
		| "audit_d1"
		| "protocol"
		| "runtime_ledger";
	minimumSuccessRate: number;
	p95LatencyMs: number;
	windowMinutes: number;
}

export const MCP_SLO_DEFINITIONS: readonly McpSloDefinition[] = [
	{
		lane: "auth",
		owner: "apps/mcp",
		canary: "reject an unauthenticated protected call with a stable reason",
		evidenceSource: "audit_d1",
		minimumSuccessRate: 0.999,
		p95LatencyMs: 1_000,
		windowMinutes: 15,
	},
	{
		lane: "discovery",
		owner: "apps/mcp",
		canary: "server/discover advertises the current protocol and extensions",
		evidenceSource: "protocol",
		minimumSuccessRate: 0.999,
		p95LatencyMs: 2_000,
		windowMinutes: 15,
	},
	{
		lane: "hydration",
		owner: "apps/mcp",
		canary: "discover.list_namespaces returns a non-degraded governed catalog",
		evidenceSource: "analytics_engine",
		minimumSuccessRate: 0.995,
		p95LatencyMs: 12_000,
		windowMinutes: 15,
	},
	{
		lane: "tool_execution",
		owner: "apps/mcp",
		canary: "execute one read-only tool and validate its result identity",
		evidenceSource: "analytics_engine",
		minimumSuccessRate: 0.995,
		p95LatencyMs: 15_000,
		windowMinutes: 15,
	},
	{
		lane: "audit",
		owner: "apps/api",
		canary: "read back the tool-call audit row by trace id",
		evidenceSource: "audit_d1",
		minimumSuccessRate: 0.999,
		p95LatencyMs: 5_000,
		windowMinutes: 15,
	},
	{
		lane: "runtime",
		owner: "apps/tedi-runtime",
		canary: "read back runtime tool.started and tool.completed events",
		evidenceSource: "runtime_ledger",
		minimumSuccessRate: 0.99,
		p95LatencyMs: 30_000,
		windowMinutes: 15,
	},
	{
		lane: "task",
		owner: "apps/mcp",
		canary: "create or observe a task and reach a terminal tasks/get state",
		evidenceSource: "protocol",
		minimumSuccessRate: 0.99,
		p95LatencyMs: 60_000,
		windowMinutes: 30,
	},
	{
		lane: "subscription",
		owner: "apps/mcp",
		canary:
			"listen, receive one complete task revision, and close the stream cleanly",
		evidenceSource: "protocol",
		minimumSuccessRate: 0.99,
		p95LatencyMs: 15_000,
		windowMinutes: 30,
	},
	{
		lane: "trace",
		owner: "apps/api",
		canary: "join protocol, audit, and runtime evidence on one trace id",
		evidenceSource: "audit_d1",
		minimumSuccessRate: 0.99,
		p95LatencyMs: 10_000,
		windowMinutes: 30,
	},
] as const;

export interface McpSloObservation {
	lane: McpSloLane;
	successRate: number;
	p95LatencyMs: number;
	sampleCount: number;
}

export type McpSloStatus = "healthy" | "breach" | "unobserved";

export function evaluateMcpSlos(observations: readonly McpSloObservation[]) {
	const byLane = new Map(observations.map((row) => [row.lane, row]));
	return MCP_SLO_DEFINITIONS.map((definition) => {
		const observation = byLane.get(definition.lane);
		if (!observation || observation.sampleCount < 1) {
			return {
				...definition,
				status: "unobserved" as const,
				observation: null,
			};
		}
		const status: McpSloStatus =
			observation.successRate >= definition.minimumSuccessRate &&
			observation.p95LatencyMs <= definition.p95LatencyMs
				? "healthy"
				: "breach";
		return { ...definition, status, observation };
	});
}
