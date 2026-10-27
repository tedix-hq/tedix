import { resolveTediScopes } from "@tedix/mcp-shared/auth/scopes";
import { getTediProfileApiClient } from "./lib/api-client";
import { UPSTREAM_RETRY_AFTER_SECONDS, withUpstreamRetry } from "./upstream";

/**
 * A tedi's live D1 authority for one request. Only `active` carries scopes:
 * an absent tedi and an unreachable lookup are distinct outcomes, and neither
 * may be read as the standard profile.
 */
export type TediProfileAuth =
	| {
			status: "active";
			scopes: string[];
			orgId: string | null;
			mcpEndpoints?: string[];
	  }
	| { status: "missing" }
	| { status: "denied"; errorCode: string }
	| { status: "unavailable"; errorCode: string };

type ErrorShape = {
	code?: unknown;
	status?: unknown;
	name?: unknown;
	response?: { status?: unknown };
};

function isNotFound(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const shaped = error as ErrorShape;
	return shaped.code === "NOT_FOUND" || errorCode(error) === "HTTP_404";
}

function errorCode(error: unknown): string {
	if (!error || typeof error !== "object") return "UNKNOWN";
	const shaped = error as ErrorShape;
	const status =
		shaped.status ??
		(shaped.name === "MalformedResponseError"
			? shaped.response?.status
			: undefined);
	if (typeof status === "number" && status >= 400 && status < 500)
		return `HTTP_${status}`;
	if (typeof shaped.code === "string") return shaped.code;
	if (typeof status === "number") return `HTTP_${status}`;
	return "UNKNOWN";
}

/**
 * Resolve a tedi's capability scopes and real org id from D1, keyed on its
 * `mcp_capability_profile`. D1 defines the tedi's current capability ceiling;
 * an AIH M2M client registered for one server may narrow it further.
 *
 * This is a cross-org identity projection keyed by the globally unique tedi
 * id, so it uses the narrow `system` service-binding scope.
 */
export async function resolveTediProfileAuth(
	env: { API_SERVICE?: CloudflareEnv["API_SERVICE"] },
	tediId: string,
): Promise<TediProfileAuth> {
	if (!env.API_SERVICE) {
		return { status: "unavailable", errorCode: "API_SERVICE_UNBOUND" };
	}
	try {
		const client = getTediProfileApiClient(env.API_SERVICE);
		const tedi = await withUpstreamRetry(() => client.tedis.get({ tediId }), {
			operation: "validate_tedi_profile",
		});
		return {
			status: "active",
			scopes: [
				...resolveTediScopes(
					typeof tedi.mcpCapabilityProfile === "string"
						? tedi.mcpCapabilityProfile
						: null,
				),
			].filter(
				(scope) =>
					tedi.toolPolicy?.mcpScopes === undefined ||
					tedi.toolPolicy.mcpScopes.includes(scope),
			),
			orgId: tedi.organizationId ?? null,
			...(tedi.toolPolicy?.mcpEndpoints === undefined
				? {}
				: { mcpEndpoints: tedi.toolPolicy.mcpEndpoints }),
		};
	} catch (error) {
		if (isNotFound(error)) return { status: "missing" };
		const code = errorCode(error);
		if (
			code === "UNAUTHORIZED" ||
			code === "FORBIDDEN" ||
			code === "HTTP_401" ||
			code === "HTTP_403"
		) {
			return { status: "denied", errorCode: code };
		}
		return { status: "unavailable", errorCode: code };
	}
}

/**
 * Fail closed for a tedi whose live profile did not resolve, keeping revoked
 * authority (403) distinct from an unavailable dependency (503, retryable).
 */
export function tediProfileFailureResponse(
	auth: Exclude<TediProfileAuth, { status: "active" }>,
	credentialMode: string,
): Response {
	console.warn(
		JSON.stringify({
			_mcp: "auth",
			event: "tedi_profile_validation_failed",
			outcome: auth.status,
			credentialMode,
			...(auth.status === "missing" ? {} : { errorCode: auth.errorCode }),
		}),
	);

	if (auth.status === "missing" || auth.status === "denied") {
		return new Response(
			JSON.stringify({
				error:
					auth.status === "missing"
						? "tedi_inactive"
						: "tedi_validation_denied",
				message:
					auth.status === "missing"
						? "Tedi identity is not active"
						: "Tedi authority validation was denied",
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
			error: "tedi_validation_unavailable",
			message: "Tedi authority could not be validated. Please retry shortly.",
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
