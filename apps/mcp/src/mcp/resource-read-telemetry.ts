import type { ServerContext } from "./server-context";
import {
	buildCallerTelemetryFields,
	emitMcpAuditEvent,
	type McpEvent,
	mergeMcpMetadata,
	trackMcpEvent,
} from "./utils/analytics";

export function trackResourceRead(
	agent: ServerContext,
	metadata: NonNullable<McpEvent["metadata"]>,
	toolName?: string,
): void {
	const callerFields = buildCallerTelemetryFields(agent.callerIdentity);
	const event: McpEvent = {
		timestamp: new Date().toISOString(),
		eventType: "resource_read",
		appId: agent.appId,
		appSlug: agent.appSlug,
		organizationId: agent.app?.organizationId,
		...callerFields,
		traceId: agent.traceId,
		...(toolName ? { toolName } : {}),
		success: true,
		metadata: mergeMcpMetadata(callerFields.metadata, metadata),
	};
	trackMcpEvent(agent.env, event);
	emitMcpAuditEvent(agent.env, event, agent.ctx.waitUntil.bind(agent.ctx));
}
