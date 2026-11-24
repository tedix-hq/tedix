/**
 * Name of an organization's wallet Durable Object (`McpSubscriptionDurableObject`
 * in the MCP Worker). The MCP Worker and the API both address it by this name,
 * so they must agree on it and on the Durable Object jurisdiction.
 */
export function walletObjectName(organizationId: string): string {
	return `wallet:v1:${organizationId}`;
}
