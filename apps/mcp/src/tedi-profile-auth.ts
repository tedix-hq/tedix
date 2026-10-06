import { resolveTediScopes } from "@tedix/mcp-shared/auth/scopes";
import { getTediProfileApiClient } from "./lib/api-client";
import { UPSTREAM_RETRY_AFTER_SECONDS } from "./upstream";

/**
 * A tedi's live D1 authority for one request. Only `active` carries scopes:
 * an absent tedi and an unreachable lookup are distinct outcomes, and neither
 * may be read as the standard profile.
 */
export type TediProfileAuth =
	| { status: "active"; scopes: string[]; orgId: string | null }
	| { status: "missing" }
	| { status: "unavailable"; errorCode: string };

type ErrorShape = { code?: unknown; status?: unknown };

function isNotFound(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const shaped = error as ErrorShape;
	return shaped.code === "NOT_FOUND" || shaped.status === 404;
}

function errorCode(error: unknown): string {
	if (!error || typeof error !== "object") return "UNKNOWN";
	const shaped = error as ErrorShape;
	if (typeof shaped.code === "string") return shaped.code;
	if (typeof shaped.status === "number") return `HTTP_${shaped.status}`;
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
		const tedi = await getTediProfileApiClient(env.API_SERVICE).tedis.get({
			tediId,
		});
		return {
			status: "active",
			scopes: [
				...resolveTediScopes(
					typeof tedi.mcpCapabilityProfile === "string"
						? tedi.mcpCapabilityProfile
						: null,
				),
			],
			orgId: tedi.organizationId ?? null,
		};
	} catch (error) {
		if (isNotFound(error)) return { status: "missing" };
		return { status: "unavailable", errorCode: errorCode(error) };
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
			...(auth.status === "unavailable" ? { errorCode: auth.errorCode } : {}),
		}),
	);

	if (auth.status === "missing") {
		return new Response(
			JSON.stringify({
				error: "tedi_inactive",
				message: "Tedi identity is not active",
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
