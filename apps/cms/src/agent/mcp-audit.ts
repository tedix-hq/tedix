import { callRpc, serviceBindingFetch } from "@tedix/api-client/internal";

export type CmsMcpAuditEvent = {
	action: "mcp.tool.execute";
	actorId: string;
	actorType: "user" | "service" | "tedi" | "m2m";
	metadata: Record<string, unknown>;
	organizationId: string;
	resourceId: string;
};

export async function recordCmsMcpAuditEvent(
	apiService: Fetcher,
	event: CmsMcpAuditEvent,
): Promise<void> {
	await callRpc(
		"audit/createEvent",
		{
			organizationId: event.organizationId,
			actorId: event.actorId,
			actorType: event.actorType,
			action: event.action,
			resourceType: "mcp_tool",
			resourceId: event.resourceId,
			metadata: { ...event.metadata, surface: "cms" },
		},
		{
			apiUrl: "https://api",
			fetch: serviceBindingFetch(apiService),
			headers: {
				"X-Service-Binding": "true",
				"X-Tedix-Org-Id": event.organizationId,
			},
		},
	);
}
