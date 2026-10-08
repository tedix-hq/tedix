/**
 * MCP Analytics — two-layer tracking (Workers Logs + Analytics Engine).
 *
 * Event types: session_init, tool_call, prompt_get, code_exec, resource_read.
 * All writes async and non-blocking. No PII stored.
 *
 * @module @tedix/mcp/analytics
 */

import { buildMcpAnalyticsDataPoint } from "@tedix/api-contract/schemas/mcp-analytics";
import {
	classifyMcpClientRegistrationMethod,
	type McpClientRegistrationMethod,
} from "@tedix/auth/oauth-client-registration";
import { getApiClient } from "../../lib/api-client";
import { createMcpLogger } from "../../log";
import {
	buildCallerAuditMetadata,
	type CallerIdentity,
	normalizeCallerIdentity,
} from "../caller-identity";
import { redactSecretValues } from "./payload-capture";

const log = createMcpLogger("mcp.analytics");

/**
 * MCP event types for analytics tracking
 */
export type McpEventType =
	| "session_init" // MCP connection established
	| "tool_call" // Tool invocation
	| "prompt_get" // Prompt invocation (prompts/get)
	| "code_exec" // Code Mode execution (wraps multiple tool calls)
	| "resource_read" // Resource accessed (widget load)
	| "auth_validation" // External-agent authority validation availability/latency
	| "access_denied"; // Pre-dispatch security decision

/**
 * MCP analytics event
 * All fields are optional except timestamp, eventType to support partial tracking
 */
export interface McpEvent {
	// Core identifiers
	timestamp: string; // ISO 8601 format
	eventType: McpEventType;
	sessionId?: string; // Unique per MCP connection (ephemeral, undefined for stateless)

	// Context (optional)
	appId?: string; // App UUID
	appSlug?: string; // Human-readable app slug (avoids UUID→name joins)
	organizationId?: string; // Organization UUID

	// Caller identity (from auth context)
	userId?: string; // Descope user ID (sub claim)
	tediId?: string; // Tedix tedi ID when the caller resolves to an agent identity
	clientId?: string; // OAuth client ID or CIMD URL
	registrationMethod?: McpClientRegistrationMethod;
	authType?:
		| "user"
		| "m2m"
		| "tedi"
		| "service"
		| "apiKey"
		| "oauth"
		| "external_agent"
		| "anonymous"; // How the caller authenticated

	// Tool/prompt call specific
	toolName?: string; // Tool or prompt identifier
	toolInputSize?: number; // Input JSON byte size
	toolOutputSize?: number; // Output JSON byte size
	durationMs?: number; // Execution time in milliseconds

	// Outcome
	success?: boolean; // true = success, false = error
	errorCode?: string; // Error code if failed (e.g., "INVALID_INPUT")
	errorMessage?: string; // Error message if failed

	// Correlation
	traceId?: string; // Per-request ID for cross-layer correlation (AE ↔ audit ↔ logs)
	executionId?: string; // Links code_exec to its inner tool_call events

	// Resource usage (future: token counting)
	tokensUsed?: number; // Tokens consumed (for AI-powered tools)

	// Extensibility
	metadata?: Record<string, string | number | boolean>; // Additional context
}

export { buildCallerAuditMetadata };

type McpMetadata = NonNullable<McpEvent["metadata"]>;

export function mergeMcpMetadata(
	...metadata: Array<McpMetadata | undefined>
): McpMetadata | undefined {
	const merged = Object.assign({}, ...metadata.filter(Boolean));
	return Object.keys(merged).length > 0 ? merged : undefined;
}

export function buildCallerTelemetryFields(
	callerIdentity: CallerIdentity | undefined,
): Pick<
	McpEvent,
	"userId" | "tediId" | "clientId" | "authType" | "registrationMethod"
> & {
	metadata?: McpMetadata;
} {
	const registrationMethod = classifyMcpClientRegistrationMethod({
		authType: callerIdentity?.authType,
		clientId: callerIdentity?.clientId,
	});
	return {
		userId: callerIdentity?.userId,
		tediId: callerIdentity?.tediId,
		clientId: callerIdentity?.clientId,
		authType: callerIdentity?.authType,
		registrationMethod,
		metadata: mergeMcpMetadata(
			buildCallerAuditMetadata(callerIdentity),
			registrationMethod ? { registrationMethod } : undefined,
		),
	};
}

type AuditActorType =
	| "user"
	| "service"
	| "tedi"
	| "m2m"
	| "external_agent"
	| "anonymous"
	| "kernel";

function getAuditActor(event: McpEvent): {
	actorId: string;
	actorType: AuditActorType;
} {
	if (event.authType === "tedi") {
		const normalized = normalizeCallerIdentity(event as CallerIdentity);
		return { actorId: normalized.actorId, actorType: normalized.actorType };
	}

	if (event.authType === "m2m") {
		return {
			actorId: event.userId ?? event.clientId ?? "m2m",
			actorType: "m2m",
		};
	}

	if (event.authType === "external_agent") {
		return {
			actorId:
				typeof event.metadata?.externalAgentPrincipalId === "string"
					? event.metadata.externalAgentPrincipalId
					: "external_agent",
			actorType: "external_agent",
		};
	}

	if (event.authType === "service") {
		// Kernel calls carry delegationMode "kernel" in the caller
		// metadata (built by buildCallerAuditMetadata from the normalized
		// identity). They audit as the tenant control-plane actor — actorId is
		// the initiating human when present (audit contract).
		if (event.metadata?.delegationMode === "kernel") {
			return {
				actorId: event.userId ?? "kernel",
				actorType: "kernel",
			};
		}
		return {
			actorId: event.userId ?? event.clientId ?? "service",
			actorType: "service",
		};
	}

	if (event.authType === "apiKey") {
		return {
			actorId: event.userId ?? event.clientId ?? "api_key",
			actorType: "m2m",
		};
	}

	if (event.userId) {
		return { actorId: event.userId, actorType: "user" };
	}

	return { actorId: event.clientId ?? "anonymous", actorType: "anonymous" };
}

/**
 * Track MCP event across two layers:
 * 1. Workers Logs (JSON) - Always written
 * 2. Analytics Engine - Always written (if binding exists)
 *
 * @param env - Cloudflare environment with bindings
 * @param event - MCP event to track
 */
export function trackMcpEvent(env: CloudflareEnv, event: McpEvent): void {
	const isDev = env.ENVIRONMENT === "development";

	// Layer 1: Structured logging for Workers Logs (always enabled)
	// Format: JSON with source field for filtering in dashboard
	const logEntry = {
		source: "mcp" as const,
		...event,
		// Add environment context
		environment: env.ENVIRONMENT,
	};

	if (isDev) {
		// Development: Pretty-print for readability
		console.log(
			`[MCP Analytics] ${event.eventType}:`,
			JSON.stringify(logEntry, null, 2),
		);
	} else {
		// Production: Single-line JSON for Cloudflare dashboard queries
		console.log(JSON.stringify(logEntry));
	}

	// Layer 2: Analytics Engine (async, non-blocking)
	// Analytics Engine binding configured in wrangler.jsonc
	if ("ANALYTICS" in env && env.ANALYTICS) {
		try {
			env.ANALYTICS.writeDataPoint(buildMcpAnalyticsDataPoint(event));

			if (isDev) {
				console.log("[MCP Analytics] Analytics Engine write queued");
			}
		} catch (error) {
			// Non-blocking: Log error but don't fail the request
			log.error("Analytics Engine write failed", {
				event: "analytics.engine_write_failed",
				appId: event.appId,
				organizationId: event.organizationId,
				traceId: event.traceId,
				outcome: "unavailable",
				error,
			});
		}
	}
}

/**
 * Write MCP tool call to the audit_events system via API.
 * This bridges MCP telemetry with the platform audit trail.
 *
 * Only emits for tool_call events with an identified caller (not anonymous).
 */
export function emitMcpAuditEvent(
	env: CloudflareEnv,
	event: McpEvent,
	waitUntil?: (promise: Promise<unknown>) => void,
): void {
	if (
		event.eventType !== "tool_call" &&
		event.eventType !== "prompt_get" &&
		event.eventType !== "code_exec" &&
		event.eventType !== "resource_read" &&
		event.eventType !== "access_denied"
	) {
		return;
	}
	if (!event.appId || !event.organizationId) return;

	const p = writeAuditEventViaApi(env, event).catch((error) => {
		log.error("Audit event emission failed", {
			event: "analytics.audit_emit_failed",
			appId: event.appId,
			organizationId: event.organizationId,
			traceId: event.traceId,
			outcome: "unavailable",
			error,
		});
	});
	if (waitUntil) waitUntil(p);
}

async function writeAuditEventViaApi(
	env: CloudflareEnv,
	event: McpEvent,
): Promise<void> {
	if (!event.organizationId || !event.appId) return;

	try {
		const externalAgentPrincipalId =
			typeof event.metadata?.externalAgentPrincipalId === "string"
				? event.metadata.externalAgentPrincipalId
				: null;
		const externalAgentSessionId =
			typeof event.metadata?.externalAgentSessionId === "string"
				? event.metadata.externalAgentSessionId
				: null;
		const externalAgentClientRecordId =
			typeof event.metadata?.externalAgentClientRecordId === "string"
				? event.metadata.externalAgentClientRecordId
				: null;
		const client = getApiClient({
			serviceFetch: env.API_SERVICE,
			orgId: event.organizationId,
			...(externalAgentPrincipalId &&
			externalAgentSessionId &&
			externalAgentClientRecordId
				? {
						externalAgent: {
							principalId: externalAgentPrincipalId,
							sessionId: externalAgentSessionId,
							clientRecordId: externalAgentClientRecordId,
						},
					}
				: {}),
		});

		const actionPrefix =
			event.eventType === "access_denied"
				? "mcp.access"
				: event.eventType === "prompt_get"
					? "mcp.prompt"
					: event.eventType === "code_exec"
						? "mcp.code"
						: event.eventType === "resource_read"
							? "mcp.resource"
							: "mcp.tool";
		const actionVerb =
			event.eventType === "access_denied"
				? "denied"
				: event.eventType === "resource_read"
					? event.success === false
						? "error"
						: "read"
					: event.success
						? "execute"
						: "error";
		const resourceId =
			event.toolName ??
			String(
				event.metadata?.resourceUri ??
					event.metadata?.skillId ??
					event.metadata?.widgetKey ??
					event.eventType,
			);
		const actor = getAuditActor(event);
		await client.audit.createEvent({
			organizationId: event.organizationId!,
			actorId: actor.actorId,
			actorType: actor.actorType,
			action: `${actionPrefix}.${actionVerb}`,
			resourceType:
				event.eventType === "access_denied"
					? "mcp_request"
					: event.eventType === "prompt_get"
						? "mcp_prompt"
						: event.eventType === "resource_read"
							? "mcp_resource"
							: "mcp_tool",
			resourceId,
			metadata: {
				appId: event.appId,
				sessionId: event.sessionId,
				durationMs: event.durationMs,
				...(event.traceId && { traceId: event.traceId }),
				...(event.executionId && { executionId: event.executionId }),
				...(event.tediId && { tediId: event.tediId }),
				...(event.errorCode && { errorCode: event.errorCode }),
				...(event.clientId && { clientId: event.clientId }),
				...event.metadata,
			},
		});
		if (
			event.authType === "external_agent" &&
			externalAgentPrincipalId &&
			externalAgentSessionId &&
			externalAgentClientRecordId
		) {
			const targetBase = event.executionId ?? event.traceId ?? event.timestamp;
			const targetId = `${targetBase}:${event.eventType}:${resourceId}`.slice(
				0,
				500,
			);
			await client.externalAgentIdentity.recordVerifiedMcpExecution({
				organizationId: event.organizationId,
				principalId: externalAgentPrincipalId,
				sessionId: externalAgentSessionId,
				clientRecordId: externalAgentClientRecordId,
				targetId,
				occurredAt: event.timestamp,
				metadata: {
					appId: event.appId,
					eventType: event.eventType,
					resourceId,
					success: event.success !== false,
					...(event.traceId && { traceId: event.traceId }),
					...(event.executionId && { executionId: event.executionId }),
				},
			});
		}
	} catch (error) {
		log.error("Audit API call failed", {
			event: "analytics.audit_api_failed",
			appId: event.appId,
			organizationId: event.organizationId,
			traceId: event.traceId,
			outcome: "unavailable",
			error,
		});
	}
}

/**
 * Helper: Calculate size of JSON object in bytes
 * Used for tracking tool input/output sizes
 *
 * @param obj - Object to measure
 * @returns Size in bytes
 */
export function getJsonSize(obj: unknown): number {
	if (!obj) return 0;
	try {
		return new TextEncoder().encode(JSON.stringify(obj)).length;
	} catch {
		return 0;
	}
}

/**
 * Helper: Truncate error message to prevent huge logs
 * @param message - Error message
 * @param maxLength - Maximum length (default: 500)
 * @returns Truncated message
 */
export function truncateErrorMessage(message: string, maxLength = 500): string {
	const redacted = redactSecretValues(message);
	if (redacted.length <= maxLength) return redacted;
	return `${redacted.substring(0, maxLength)}... (truncated)`;
}

/**
 * Convert an Error constructor name into a bounded, query-stable code.
 * Messages never participate because they may contain customer or credential data.
 */
export function normalizeMcpErrorCode(error: unknown): string {
	if (!(error instanceof Error)) return "UNKNOWN_ERROR";
	if (error.name === "Error") return "UNHANDLED_ERROR";
	const normalized = error.name
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/[^A-Za-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.toUpperCase();
	return normalized.length > 0 && normalized.length <= 64
		? normalized
		: "UNHANDLED_ERROR";
}
