export const AGENT_CARD_PATH = "/.well-known/agent-card.json";
export const LEGACY_AGENT_CARD_PATH = "/.well-known/ai-agent.json";

const MCP_PROTOCOL_BINDING =
	"https://modelcontextprotocol.io/specification/2026-07-28";

export const tedixAgentCard = {
	name: "Tedix",
	description:
		"A platform for agents, apps, and work. Connect AI assistants to shared tasks, project knowledge, apps, decisions, and results through MCP.",
	supportedInterfaces: [
		{
			url: "https://tedix-unified.mcp.tedix.dev/mcp",
			protocolBinding: MCP_PROTOCOL_BINDING,
			protocolVersion: "1.0",
		},
	],
	provider: {
		organization: "Tedix",
		url: "https://tedix.dev",
	},
	version: "1.0.0",
	documentationUrl: "https://docs.tedix.dev",
	iconUrl: "https://tedix.dev/images/tedi-astronaut-waving.png",
	capabilities: {
		streaming: false,
		pushNotifications: false,
		extendedAgentCard: false,
	},
	securitySchemes: {
		bearer: {
			httpAuthSecurityScheme: {
				description:
					"Bearer token obtained through the MCP endpoint's OAuth protected-resource discovery metadata.",
				scheme: "Bearer",
				bearerFormat: "JWT",
			},
		},
	},
	securityRequirements: [{ schemes: { bearer: { list: [] } } }],
	defaultInputModes: ["text/plain", "application/json"],
	defaultOutputModes: ["text/plain", "application/json"],
	skills: [
		{
			id: "coordinate-digital-workers",
			name: "Coordinate People and AI Agents",
			description:
				"Ask Home to coordinate a task, see who is doing what, and find the results.",
			tags: ["coordination", "agents", "tasks", "results"],
			examples: [
				"Ask Home to coordinate a task for my organization.",
				"Read a task's current progress and results.",
			],
		},
		{
			id: "discover-mcp-apps",
			name: "Discover MCP Apps",
			description:
				"Discover the MCP apps and capability metadata available to the authenticated organization.",
			tags: ["discovery", "mcp", "apps", "capabilities"],
			examples: ["List the MCP apps available to my organization."],
		},
	],
} as const;

export function agentCardResponse(): Response {
	return new Response(JSON.stringify(tedixAgentCard, null, 2), {
		headers: {
			"Cache-Control": "public, max-age=3600",
			"Content-Type": "application/a2a+json; charset=utf-8",
		},
	});
}
