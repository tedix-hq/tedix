import { getApiClient } from "../lib/api-client";
import { gateDecisionMetadata } from "./gate-decision";
import {
	extractMcpTraceMeta,
	resolveInboundTraceId,
} from "@tedix/mcp-shared/trace-context";
import { extractCallerIdentity } from "./server-factory";
import {
	buildCallerTelemetryFields,
	emitMcpAuditEvent,
	type McpEvent,
	mergeMcpMetadata,
	trackMcpEvent,
} from "./utils/analytics";
import type { ResolvedApp } from "../resolution";

export const MCP_ACCESS_DENIAL_REASONS = [
	"authentication_required",
	"authentication_failed",
	"oauth_audience_not_configured",
	"direct_tedi_jwt_not_allowed",
	"tenant_mismatch",
	"tenant_match_check_failed",
	"insufficient_scope",
	"rate_limited",
	"forbidden_origin",
	"invalid_origin",
	"app_disabled",
	"protocol_header_mismatch",
	"missing_client_capability",
	"unsupported_protocol_version",
] as const;

export type McpAccessDenialReason = (typeof MCP_ACCESS_DENIAL_REASONS)[number];

/**
 * Edge refusals that write no change record. The first three have no
 * verified caller to attribute the call to, and a throttled request must not
 * cost a database write. All four still emit the denial telemetry below.
 */
const UNRECORDED_EDGE_REFUSALS: ReadonlySet<McpAccessDenialReason> = new Set([
	"authentication_required",
	"authentication_failed",
	"oauth_audience_not_configured",
	"rate_limited",
]);

const SAFE_OPERATION_ID = /^[A-Za-z0-9_.:/-]{1,200}$/;

function safeOperationId(value: unknown): string | undefined {
	return typeof value === "string" && SAFE_OPERATION_ID.test(value)
		? value
		: undefined;
}

async function readRequestEnvelope(request: Request): Promise<{
	method?: string;
	toolName?: string;
	args?: Record<string, unknown>;
	traceMeta?: Record<string, unknown>;
}> {
	const headerMethod = safeOperationId(request.headers.get("Mcp-Method"));
	const headerToolName = safeOperationId(request.headers.get("Mcp-Name"));
	const contentType = request.headers.get("Content-Type") ?? "";
	if (request.method !== "POST" || !contentType.includes("application/json")) {
		return { method: headerMethod, toolName: headerToolName };
	}

	try {
		const body = (await request.clone().json()) as unknown;
		const record =
			typeof body === "object" && body !== null && !Array.isArray(body)
				? (body as Record<string, unknown>)
				: null;
		const params =
			record &&
			typeof record.params === "object" &&
			record.params !== null &&
			!Array.isArray(record.params)
				? (record.params as Record<string, unknown>)
				: null;
		return {
			method: headerMethod ?? safeOperationId(record?.method),
			toolName: headerToolName ?? safeOperationId(params?.name),
			args:
				typeof params?.arguments === "object" &&
				params.arguments !== null &&
				!Array.isArray(params.arguments)
					? (params.arguments as Record<string, unknown>)
					: {},
			traceMeta: extractMcpTraceMeta(body),
		};
	} catch {
		return { method: headerMethod, toolName: headerToolName };
	}
}

export async function recordMcpAccessDenial(input: {
	request: Request;
	resolvedApp: ResolvedApp;
	env: CloudflareEnv;
	ctx: ExecutionContext;
	reason: McpAccessDenialReason;
	httpStatus: number;
}): Promise<void> {
	const { request, resolvedApp, env, ctx, reason, httpStatus } = input;
	if (!resolvedApp.app.organizationId) return;

	const operation = await readRequestEnvelope(request);
	const traceId = resolveInboundTraceId(request.headers, operation.traceMeta);
	const callerIdentity = extractCallerIdentity(request);
	if (
		operation.method === "tools/call" &&
		operation.toolName &&
		callerIdentity &&
		!UNRECORDED_EDGE_REFUSALS.has(reason)
	) {
		try {
			const { recordGatewayRefusal } = await import("./gateway-adapters");
			const tool = resolvedApp.tools.find(
				(tool) => tool.toolId === operation.toolName,
			) ?? {
				toolId: operation.toolName,
				title: operation.toolName,
				inputSchema: { type: "object" as const, properties: {} },
			};
			await recordGatewayRefusal(
				{
					agent: {
						env,
						app: {
							id: resolvedApp.app.id,
							slug: resolvedApp.app.slug,
							name: resolvedApp.app.name,
							domain: resolvedApp.app.domain ?? null,
							organizationId: resolvedApp.app.organizationId,
						},
						appId: resolvedApp.app.id,
						appSlug: resolvedApp.app.slug,
						callerIdentity,
						traceId,
						apiClient: getApiClient({
							serviceFetch: env.API_SERVICE,
							orgId: resolvedApp.app.organizationId,
						}),
					},
					tool,
					annotations: undefined,
					args: operation.args ?? {},
				},
				"edge_access",
				reason,
			);
		} catch (error) {
			console.error(
				JSON.stringify({
					level: "error",
					event: "gateway_change_record_write_failed",
					message: "An edge refusal has no stored change record.",
					error: error instanceof Error ? error.message : String(error),
					organizationId: resolvedApp.app.organizationId,
					appId: resolvedApp.app.id,
					traceId,
					operation: operation.toolName,
					reason,
				}),
			);
		}
	}
	const callerFields = buildCallerTelemetryFields(callerIdentity);
	const event: McpEvent = {
		timestamp: new Date().toISOString(),
		eventType: "access_denied",
		appId: resolvedApp.app.id,
		appSlug: resolvedApp.app.slug,
		organizationId: resolvedApp.app.organizationId,
		toolName: operation.toolName ?? operation.method,
		success: false,
		errorCode: reason,
		traceId,
		...callerFields,
		metadata: mergeMcpMetadata(callerFields.metadata, {
			...gateDecisionMetadata("edge_access", "deny", reason),
			denialReason: reason,
			httpStatus,
			...(operation.method ? { mcpMethod: operation.method } : {}),
		}),
	};

	trackMcpEvent(env, event);
	emitMcpAuditEvent(env, event, ctx.waitUntil.bind(ctx));
}

export async function classifyProtocolDenial(
	response: Response,
): Promise<McpAccessDenialReason | null> {
	if (response.status !== 400 && response.status !== 404) return null;
	try {
		const payload = (await response.clone().json()) as unknown;
		const envelope = Array.isArray(payload) ? payload[0] : payload;
		if (typeof envelope !== "object" || envelope === null) return null;
		const error = (envelope as Record<string, unknown>).error;
		if (typeof error !== "object" || error === null) return null;
		const code = (error as Record<string, unknown>).code;
		if (code === -32_020) return "protocol_header_mismatch";
		if (code === -32_021) return "missing_client_capability";
		if (code === -32_022) return "unsupported_protocol_version";
		return null;
	} catch {
		return null;
	}
}

export async function recordProtocolDenialIfPresent(input: {
	request: Request;
	response: Response;
	resolvedApp: ResolvedApp;
	env: CloudflareEnv;
	ctx: ExecutionContext;
}): Promise<Response> {
	const reason = await classifyProtocolDenial(input.response);
	if (reason) {
		await recordMcpAccessDenial({
			request: input.request,
			resolvedApp: input.resolvedApp,
			env: input.env,
			ctx: input.ctx,
			reason,
			httpStatus: input.response.status,
		});
	}
	return input.response;
}
