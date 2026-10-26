import { buildMcpUpstreamProtocolDataPoint } from "@tedix/api-contract/schemas/mcp-analytics";
import { createTelemetryWriter } from "@tedix/worker-kit/telemetry";
import type { CallerIdentity } from "./caller-identity";

/** Upstream MCP protocol metrics: one Analytics Engine point per proxied call. */

const writeProtocolTelemetry = createTelemetryWriter("mcp.upstream.analytics");

export function emitUpstreamProtocolMetric(
	env: CloudflareEnv,
	event: Parameters<typeof buildMcpUpstreamProtocolDataPoint>[0],
): void {
	writeProtocolTelemetry(() =>
		env.ANALYTICS?.writeDataPoint(buildMcpUpstreamProtocolDataPoint(event)),
	);
}

export function classifyUpstreamProtocolCaller(
	caller: CallerIdentity | undefined,
): Parameters<typeof buildMcpUpstreamProtocolDataPoint>[0]["callerClass"] {
	if (!caller || caller.authType === "anonymous") return "unknown";
	if (caller.authType === "service" && caller.kernel === true) return "os";
	if (
		caller.authType === "tedi" ||
		(caller.authType === "service" && Boolean(caller.tediId))
	) {
		return "tedi_runtime";
	}
	if (caller.authType === "oauth" || caller.authType === "user") {
		return "human_client";
	}
	if (caller.authType === "apiKey" || caller.authType === "m2m") {
		return "api_client";
	}
	if (caller.authType === "external_agent") return "external_agent";
	return "internal_service";
}
