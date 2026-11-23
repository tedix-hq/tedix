import type { McpAuditBatchInput } from "@tedix/api-contract/schemas/audit";
import { createTelemetryWriter } from "@tedix/worker-kit/telemetry";
import { getApiClient } from "../../lib/api-client";

type Batch = {
	events: McpAuditBatchInput["events"];
	flushed: Promise<void>;
	dropped: number;
};
const writeDiagnostic = createTelemetryWriter("mcp.audit.batch");
const buffers = new WeakMap<Fetcher, Map<string, Batch>>();

export function enqueueMcpAuditEvent(
	service: Fetcher,
	organizationId: string,
	event: McpAuditBatchInput["events"][number],
): Promise<void> {
	let organizations = buffers.get(service);
	if (!organizations) {
		organizations = new Map();
		buffers.set(service, organizations);
	}
	const pending = organizations.get(organizationId);
	if (pending) {
		// Optional telemetry must not grow memory without bound under a burst.
		if (pending.events.length < 100) pending.events.push(event);
		else pending.dropped++;
		return pending.flushed;
	}
	const events = [event];
	const flushed = new Promise<void>((resolve) =>
		setTimeout(resolve, 1000),
	).then(async () => {
		const dropped = organizations.get(organizationId)!.dropped;
		organizations.delete(organizationId);
		if (dropped > 0)
			writeDiagnostic(() =>
				console.warn(
					JSON.stringify({
						event: "mcp.audit.batch_overflow",
						organizationId,
						dropped,
					}),
				),
			);
		// Use gateway identity: a batch can contain several callers.
		await getApiClient({
			serviceFetch: service,
			orgId: organizationId,
		}).audit.createTelemetryBatch({ organizationId, events });
	});
	organizations.set(organizationId, { events, flushed, dropped: 0 });
	return flushed;
}
