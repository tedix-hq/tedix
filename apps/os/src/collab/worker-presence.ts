import { resolveProductSession } from "@tedix/auth/product-session-broker";
import { validateToken } from "@tedix/auth/jwt";
import { extractBearerToken } from "@tedix/worker-kit/request-auth";
import { OS_BROKER_SESSION_COOKIE } from "../auth/session-broker";
import type {
	CollabParticipantKind,
	CollabParticipantRole,
	CollabVerifiedIdentity,
} from "./presence";

type PresencePayload = Record<string, unknown>;
type PresenceVerifier = typeof validateToken;

function claimString(payload: PresencePayload, key: string): string | null {
	const value = payload[key];
	return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function claimStrings(payload: PresencePayload, key: string): string[] {
	const value = payload[key];
	return Array.isArray(value)
		? value.filter(
				(item): item is string =>
					typeof item === "string" && item.trim() !== "",
			)
		: [];
}

function displayName(
	payload: PresencePayload,
	kind: CollabParticipantKind,
): string {
	const candidate = claimString(payload, "name");
	if (candidate && candidate.length <= 100 && !candidate.includes("@")) {
		return candidate;
	}
	return kind === "tedi"
		? "Tedi"
		: kind === "external_agent"
			? "External agent"
			: "Tedix member";
}

function participantRole(
	payload: PresencePayload,
	kind: CollabParticipantKind,
): CollabParticipantRole {
	if (kind !== "human") return "operator";
	const roles = new Set(
		claimStrings(payload, "roles").map((role) => role.toLowerCase()),
	);
	if (roles.has("owner")) return "owner";
	if (roles.has("admin") || roles.has("admin")) return "admin";
	if (roles.has("viewer")) return "viewer";
	return "member";
}

async function opaqueKey(input: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(input),
	);
	return `p_${[...new Uint8Array(digest)]
		.slice(0, 16)
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("")}`;
}

export async function collabIdentityFromPayload(
	payload: PresencePayload,
	hostTenantId: string,
): Promise<CollabVerifiedIdentity | null> {
	const entityType = claimString(payload, "entityType");
	const tediId = claimString(payload, "tediId");
	const externalAgentId = claimString(payload, "externalAgentPrincipalId");
	const clientId = claimString(payload, "client_id");
	const subject = claimString(payload, "sub");

	let kind: CollabParticipantKind;
	let rawId: string | null;
	if (entityType === "tedi" && tediId) {
		kind = "tedi";
		rawId = tediId;
	} else if (externalAgentId || clientId) {
		kind = "external_agent";
		rawId = externalAgentId ?? clientId;
	} else {
		kind = "human";
		rawId = subject;
	}
	if (!rawId) return null;
	// Human sessions must be minted for the hostname tenant. Machine tokens do
	// not consistently carry dct; their host-org authority was already proven by
	// the canonical Workspace read immediately before this projection.
	if (kind === "human" && claimString(payload, "dct") !== hostTenantId) {
		return null;
	}

	return {
		key: await opaqueKey(`${hostTenantId}:${kind}:${rawId}`),
		displayName: displayName(payload, kind),
		kind,
		role: participantRole(payload, kind),
		verified: true,
	};
}

function bearerToken(request: Request): string | null {
	return (
		extractBearerToken(request.headers.get("Authorization")) ??
		request.headers.get("X-API-Key")?.trim() ??
		null
	);
}

/** Verify a browser or direct-agent JWT and project only its safe roster identity. */
export async function authenticateCollabPresence(
	request: Request,
	projectId: string,
	hostTenantId: string,
	verify: PresenceVerifier = validateToken,
	trustedSessionToken?: string,
): Promise<CollabVerifiedIdentity | null> {
	const token =
		trustedSessionToken ??
		resolveProductSession(
			request.headers.get("Cookie"),
			OS_BROKER_SESSION_COOKIE,
		) ??
		bearerToken(request);
	if (!token) return null;
	try {
		const payload = await verify(token, { projectId, allowTediJwt: true });
		return collabIdentityFromPayload(
			payload as unknown as PresencePayload,
			hostTenantId,
		);
	} catch {
		return null;
	}
}

/** Credential-free local development still gets a stable, non-authoritative peer label. */
export async function localCollabPresence(
	tenantSlug: string,
): Promise<CollabVerifiedIdentity> {
	return {
		key: await opaqueKey(`local:${tenantSlug}`),
		displayName: "Local collaborator",
		kind: "human",
		role: "owner",
		verified: true,
	};
}
