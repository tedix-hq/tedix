/** Authentication shared by kernel voice routes and scoped-token minting. */

import { isUserToken, validateToken } from "@tedix/auth/jwt";
import { getTenantId } from "@tedix/auth/types";
import {
	extractBearerToken,
	extractWebSocketBearerToken,
} from "@tedix/worker-kit/request-auth";
import { createDbClient } from "@tedix/db/client";
import { getMemberByUserId } from "@tedix/db/queries/organization-members";
import { getOrganizationByDescopeId } from "@tedix/db/queries/organizations";
import { verifyKernelWsToken } from "./ws-token";

interface KernelIdentity {
	descopeUserId: string;
	organizationId: string;
}

type KernelAuthResult =
	| { ok: true; identity: KernelIdentity }
	| { ok: false; response: Response };

export function jsonError(
	status: number,
	error: string,
	message: string,
): Response {
	return Response.json({ error, message }, { status });
}

export function extractKernelEdgeToken(request: Request): string | null {
	return (
		extractBearerToken(request.headers.get("Authorization")) ??
		extractWebSocketBearerToken(request.headers.get("Sec-WebSocket-Protocol"))
	);
}

export function readPlatformServiceToken(env: CloudflareEnv): string | null {
	const token = (env as CloudflareEnv & { PLATFORM_SERVICE_TOKEN?: string })
		.PLATFORM_SERVICE_TOKEN;
	return typeof token === "string" && token.length > 0 ? token : null;
}

/** Authenticate voice requests with a scoped token or a validated user session. */
export async function authenticateKernelEdge(
	request: Request,
	env: CloudflareEnv,
): Promise<KernelAuthResult> {
	const token = extractKernelEdgeToken(request);
	if (!token) {
		return {
			ok: false,
			response: jsonError(401, "Unauthorized", "Missing token"),
		};
	}

	const requestedOrganizationId = new URL(request.url).searchParams.get(
		"organization",
	);

	// Path 1 — scoped kernel WS token (no Descope round-trip).
	const platformServiceToken = readPlatformServiceToken(env);
	if (platformServiceToken) {
		const scoped = await verifyKernelWsToken(token, platformServiceToken);
		if (scoped) {
			if (
				requestedOrganizationId &&
				requestedOrganizationId !== scoped.organizationId
			) {
				// Same Descope-id-vs-D1-UUID normalization as the JWT path below:
				// the Tedix OS client names the org by its Descope tenant id; accept it
				// when it resolves to the token's scoped org (cold path — one DB
				// read only on mismatch).
				const requestedOrg = await getOrganizationByDescopeId(
					createDbClient(env.DB),
					requestedOrganizationId,
				).catch(() => null);
				if (requestedOrg?.id !== scoped.organizationId) {
					return {
						ok: false,
						response: jsonError(
							403,
							"Forbidden",
							"Token is not scoped to the requested organization",
						),
					};
				}
			}
			return {
				ok: true,
				identity: {
					descopeUserId: scoped.descopeUserId,
					organizationId: scoped.organizationId,
				},
			};
		}
	}

	return authenticateKernelSessionJwt(token, requestedOrganizationId, env);
}

/** Validate a user session and resolve its authorized canonical organization. */
export async function authenticateKernelSessionJwt(
	token: string,
	requestedOrganizationId: string | null,
	env: CloudflareEnv,
): Promise<KernelAuthResult> {
	let payload: Awaited<ReturnType<typeof validateToken>>;
	try {
		payload = await validateToken(token, {
			projectId: env.DESCOPE_PROJECT_ID,
			baseUrl: env.DESCOPE_BASE_URL,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : "invalid token";
		return { ok: false, response: jsonError(401, "Unauthorized", message) };
	}
	if (!isUserToken(payload) || !payload.sub) {
		return {
			ok: false,
			response: jsonError(
				401,
				"Unauthorized",
				"Token is not a user session token",
			),
		};
	}

	const db = createDbClient(env.DB);
	const tenantId = getTenantId(payload);
	let claimOrganizationId: string | null = null;
	if (tenantId) {
		try {
			claimOrganizationId =
				(await getOrganizationByDescopeId(db, tenantId))?.id ?? null;
		} catch (error) {
			console.warn(
				"[kernel.edge] claim org resolution failed",
				error instanceof Error ? error.message : String(error),
			);
		}
	}
	// Normalize the user's own Descope tenant alias before checking membership
	// in the canonical D1 organization namespace.
	const normalizedRequestedOrganizationId =
		requestedOrganizationId && tenantId && requestedOrganizationId === tenantId
			? claimOrganizationId
			: requestedOrganizationId;
	const organizationId =
		normalizedRequestedOrganizationId ?? claimOrganizationId;
	if (!organizationId) {
		return {
			ok: false,
			response: jsonError(403, "Forbidden", "No organization context"),
		};
	}
	if (organizationId !== claimOrganizationId) {
		const member = await getMemberByUserId(
			db,
			organizationId,
			payload.sub,
		).catch(() => null);
		if (!member) {
			return {
				ok: false,
				response: jsonError(
					403,
					"Forbidden",
					"Not a member of the requested organization",
				),
			};
		}
	}

	return {
		ok: true,
		identity: { descopeUserId: payload.sub, organizationId },
	};
}
