import {
	UPSTREAM_RETRY_AFTER_SECONDS,
	isRetryableUpstreamError,
} from "./upstream";
import { trackMcpEvent } from "./mcp/utils/analytics";

type ErrorShape = {
	code?: unknown;
	status?: unknown;
};

function isInactiveSessionError(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const shaped = error as ErrorShape;
	return shaped.code === "NOT_FOUND" || shaped.status === 404;
}

export function recordExternalAgentValidation(input: {
	env: CloudflareEnv;
	appId?: string;
	appSlug?: string;
	organizationId: string;
	durationMs: number;
	error?: unknown;
}): void {
	const inactive = input.error ? isInactiveSessionError(input.error) : false;
	const outcome = input.error
		? inactive
			? "inactive"
			: "validation_unavailable"
		: "success";

	trackMcpEvent(input.env, {
		timestamp: new Date().toISOString(),
		eventType: "auth_validation",
		appId: input.appId,
		appSlug: input.appSlug,
		organizationId: input.organizationId,
		authType: "external_agent",
		toolName: "external_agent_session",
		durationMs: input.durationMs,
		success: !input.error,
		errorCode: input.error ? outcome : undefined,
		metadata: { validationOutcome: outcome },
	});
}

function safeErrorCode(error: unknown): string {
	if (!error || typeof error !== "object") return "UNKNOWN";
	const shaped = error as ErrorShape;
	if (typeof shaped.code === "string") return shaped.code;
	if (typeof shaped.status === "number") return `HTTP_${shaped.status}`;
	return "UNKNOWN";
}

/**
 * Fail closed while preserving the operational distinction between revoked or
 * expired authority and an unavailable/misconfigured validation dependency.
 */
export function externalAgentValidationFailureResponse(
	error: unknown,
): Response {
	const inactive = isInactiveSessionError(error);
	const retryable = isRetryableUpstreamError(error);
	const outcome = inactive ? "inactive" : "validation_unavailable";

	console.warn(
		JSON.stringify({
			_mcp: "auth",
			event: "external_agent_validation_failed",
			outcome,
			errorCode: safeErrorCode(error),
			retryable,
		}),
	);

	if (inactive) {
		return new Response(
			JSON.stringify({
				error: "external_agent_inactive",
				message: "External-agent principal or session is not active",
			}),
			{
				status: 403,
				headers: {
					"Content-Type": "application/json",
					"Cache-Control": "private, no-store",
				},
			},
		);
	}

	return new Response(
		JSON.stringify({
			error: "external_agent_validation_unavailable",
			message:
				"External-agent authority could not be validated. Please retry shortly.",
			retryAfter: UPSTREAM_RETRY_AFTER_SECONDS,
		}),
		{
			status: 503,
			headers: {
				"Content-Type": "application/json",
				"Retry-After": String(UPSTREAM_RETRY_AFTER_SECONDS),
				"Cache-Control": "private, no-store",
			},
		},
	);
}
