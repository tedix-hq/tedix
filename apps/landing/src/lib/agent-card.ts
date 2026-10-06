export const AGENT_CARD_PATH = "/.well-known/agent-card.json";
export const LEGACY_AGENT_CARD_PATH = "/.well-known/ai-agent.json";

const MCP_PROTOCOL_BINDING =
	"https://modelcontextprotocol.io/specification/2026-07-28";

export const tedixAgentCard = {
	name: "Tedix",
	description:
		"Governed digital workers that coordinate durable work through authenticated MCP tools.",
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
			name: "Coordinate Digital Workers",
			description:
				"Submit governed work to Home, coordinate organization tedis, and recover durable task results.",
			tags: ["coordination", "digital-workers", "durable-tasks", "governance"],
			examples: [
				"Ask Home to coordinate a governed task for my organization.",
				"Read the current status of a durable task.",
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
