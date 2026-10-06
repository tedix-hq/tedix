import { callRpc, serviceBindingFetch } from "@tedix/api-client/internal";
import type { TediMcpAuditEvent } from "./mcp-mount";

export async function recordDirectMcpAuditEvent(
	apiService: Fetcher,
	organizationId: string,
	tediId: string,
	event: TediMcpAuditEvent,
): Promise<void> {
	await callRpc(
		"audit/createEvent",
		{
			organizationId,
			actorId: event.actorId,
			actorType: event.actorType === "client" ? "m2m" : event.actorType,
			action: event.action,
			resourceType: "mcp_tool",
			resourceId: event.resourceId,
			metadata: { ...event.metadata, surface: "direct_tedi", tediId },
		},
		{
			apiUrl: "https://api",
			fetch: serviceBindingFetch(apiService),
			headers: {
				"X-Service-Binding": "true",
				"X-Tedix-Org-Id": organizationId,
				"X-Tedix-Tedi-Id": tediId,
			},
		},
	);
}
