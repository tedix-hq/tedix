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
 * The header is authoritative and the only signal. Every first-party sender
 * stamps it: the gateway (`apps/mcp`) from the authenticated caller, the
 * kernel's delegation and approval-redrive injects (`@tedix/provisioning`
 * `injectAgentMessage`, `apps/api` `work-approval-redrive`) as `member`, and
 * mesh tedi→tedi inject as `tedi`. A missing or malformed header fails
 * closed to `foreign`: the turn runs on the untrusted surface and its
 * member-only fields (`learning_mode`, `metadata`) are stripped.
 */
export function callerTrustTierForRequest(headers: Headers): CallerTrustTier {
	return parseCallerTrustTier(headers.get(CALLER_TRUST_HEADER)) ?? "foreign";
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
