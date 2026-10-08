/**
 * Caller trust for a turn that enters the runtime over MCP.
 *
 * The gateway (apps/mcp) stamps `x-tedix-caller-trust` on every internal
 * service-binding request it makes; `caller-trust.ts` in `@tedix/mcp-shared`
 * is the shared contract. This module is the runtime side: which tier a
 * request carries, what that tier means for the turn's surface trust, and
 * how a direct (non-gateway) `/mcp` caller's authentication maps to a tier.
 */
import type { McpAuthContext } from "@tedix/mcp-shared/auth/types";
import {
	CALLER_TRUST_HEADER,
	type CallerTrustTier,
	isPlatformTrustedCaller,
	parseCallerTrustTier,
} from "@tedix/mcp-shared/auth/caller-trust";
import type { SurfaceTrust } from "./turn-trust";

/**
 * Tier of a request on an internal, service-binding-only route.
 *
 * The header is authoritative when present. Public ingress strips the
 * service-binding marker, so a request with no header can only come from a
 * first-party Worker that authored the text itself and predates the header:
 * the kernel's delegation and approval-redrive injects (`apps/api`),
 * provisioning, and mesh tedi→tedi inject. Those carry `metadata`
 * (workItemId, homeRunId) that a `foreign` tier would strip, so an absent
 * header is `member`, not `foreign`. A malformed header is `foreign`.
 */
export function callerTrustTierForRequest(headers: Headers): CallerTrustTier {
	const raw = headers.get(CALLER_TRUST_HEADER);
	if (raw === null) return "member";
	return parseCallerTrustTier(raw) ?? "foreign";
}

/**
 * Tier for a caller that authenticated directly at the runtime edge (no
 * gateway hop). The edge already enforced that a tedi JWT names this tedi,
 * that a user JWT's tenant matches the organization, and that an API key
 * belongs to it; this only names the tier those checks imply.
 */
export function callerTrustTierForDirectMcpAuth(
	auth:
		| Pick<McpAuthContext, "authenticated" | "authMethod" | "tediId" | "scopes">
		| undefined,
): CallerTrustTier {
	if (!auth?.authenticated || auth.authMethod === "none") return "foreign";
	if (isPlatformTrustedCaller(auth)) return "member";
	if (auth.tediId) return "tedi";
	return "member";
}

/**
 * Surface trust of a durable MCP turn. A Home-delegated turn (Work Item and
 * Home run present) is authorized by Home's dispatch decision and runs on the
 * delegation ceiling, whatever the transport tier; only a plain turn from a
 * `foreign` caller is untrusted.
 */
export function mcpTurnSurfaceTrust(input: {
	callerTrust?: CallerTrustTier;
	workItemId?: string;
	homeRunId?: string;
}): SurfaceTrust {
	if (input.workItemId && input.homeRunId) return "trusted";
	return input.callerTrust === "foreign" ? "untrusted" : "trusted";
}
