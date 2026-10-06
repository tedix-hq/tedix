export const CMS_MCP_DISCOVERY = {
	serverInfo: { name: "Tedix Site Builder MCP", version: "1.0.0" },
	capabilities: { tools: {} },
} as const;

/** Modern discovery must publish the same tenant instructions as the SDK server. */
export function buildCmsMcpDiscovery(instructions: string) {
	return { ...CMS_MCP_DISCOVERY, instructions };
}
