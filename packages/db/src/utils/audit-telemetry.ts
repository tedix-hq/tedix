// Only execution telemetry belongs in LOGS_DB. Access, payment, authority and
// unknown future actions keep main-D1 persistence.
export const MCP_TELEMETRY_ACTIONS: ReadonlySet<string> = new Set([
	"mcp.tool.execute",
	"mcp.tool.error",
	"mcp.code.execute",
	"mcp.code.error",
	"mcp.prompt.execute",
	"mcp.prompt.error",
	"mcp.resource.read",
	"mcp.resource.error",
]);
