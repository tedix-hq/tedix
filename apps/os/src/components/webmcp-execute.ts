import type { WebMcpToolResult } from "@tedix/webmcp-core/model-context";
import {
	webMcpContextUnavailable,
	webMcpError,
} from "@tedix/webmcp-core/model-context";

/**
 * Shared execute-time failure mapping for every WebMCP tool module.
 *
 * The readiness doctrine (docs/engineering/product/tedix-os.md, "Readiness, tenant
 * binding, and multiple tabs") requires that a tool discoverable before the
 * tenant session is executable return ONE stable, typed, retryable
 * `context_unavailable` result — never an ad hoc message. Registration is
 * already mount-gated by `SessionBoundary` (children render only once the
 * broker session is authenticated), so the residual risk this classifier
 * covers is mid-session loss of authority: the broker session cookie expires
 * while the page holds, or the credential loses its organization scope.
 *
 * Both surface as oRPC error envelopes carrying a `code`:
 * - `UNAUTHORIZED` — the OS worker's `/api` proxy refuses pre-flight
 *   (`refuseApi` in `src/worker.ts`) or `apps/api` `withAuth` rejects the
 *   forwarded credential.
 * - `FORBIDDEN` — `apps/api`'s canonical org-scope guard
 *   (`apps/api/src/rpc/org-scope.ts`): the caller is authenticated but the
 *   organization context is not bound/executable for the call.
 *
 * oRPC v2's client `ORPCError` carries no `status` field (the HTTP status is
 * derived from the code by the handler codec), so classification is by `code`
 * — the same structural idiom the CAS-conflict mapping in
 * `outputs-webmcp-tools.ts` already uses. Deliberately structural rather than
 * `instanceof ORPCError`: this module stays pure (no app-bootstrap or
 * transport imports) so tool modules can import it at module scope.
 */
const CONTEXT_UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
	"UNAUTHORIZED",
	"FORBIDDEN",
]);

/** True when the failure means the tenant session/org context is not executable. */
export function isContextUnavailableError(error: unknown): boolean {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" && CONTEXT_UNAVAILABLE_CODES.has(code);
}

export function webMcpFailureMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Map a caught execute() failure to a WebMCP result. Domain-specific
 * classifications (e.g. CAS revision conflicts) run BEFORE this fallback in
 * the callers; this is the uniform last step and never throws.
 */
export function toWebMcpFailure(error: unknown): WebMcpToolResult {
	if (isContextUnavailableError(error)) {
		return webMcpContextUnavailable(webMcpFailureMessage(error));
	}
	return webMcpError(webMcpFailureMessage(error));
}
