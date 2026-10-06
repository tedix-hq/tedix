/**
 * oRPC client-error introspection for the Tedix OS surfaces.
 *
 * The OS reads canonical `apps/api` procedures whose authorization planes
 * differ: `workItems.*` is a single-plane `withAuth` exemption, while
 * `organizationPurpose.*` additionally requires `settings:manage`/`apps:read`
 * and `projects.list` requires `tedis:read`/`mcp:memory`. A member who can see
 * the board therefore CAN legitimately be refused the purpose charter or the
 * project list. That is an authorization state, not an outage, and a surface
 * that renders it as "unavailable — Forbidden" teaches the operator to distrust
 * a working system. These helpers let each section tell the two apart.
 */

/** The oRPC error `code` on a thrown client error, when it carries one. */
export function orpcErrorCode(error: unknown): string | null {
	if (typeof error !== "object" || error === null) return null;
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" ? code : null;
}

/**
 * True when the read was REFUSED for this principal rather than failing.
 * `UNAUTHORIZED` (no/expired credential) and `FORBIDDEN` (credential lacks the
 * scope or role) are both "you may not read this", which no retry fixes.
 */
export function isAuthorizationError(error: unknown): boolean {
	const code = orpcErrorCode(error);
	return code === "FORBIDDEN" || code === "UNAUTHORIZED";
}

/**
 * True when the server answered that the addressed resource does not exist.
 *
 * This is the ONLY evidence of absence a surface may act on. A slow read, an
 * aborted request, or a transport failure is silence, not a 404 — rendering
 * "not found" for any of those tells the operator their data is gone when it
 * may be sitting on the other side of a cold isolate.
 */
export function isNotFoundError(error: unknown): boolean {
	return orpcErrorCode(error) === "NOT_FOUND";
}

/**
 * Human-readable failure text. Prefers the server's message, falls back to the
 * caller's phrase — never renders "undefined" or "[object Object]".
 */
export function errorMessage(
	error: unknown,
	fallback = "The request failed.",
): string {
	if (typeof error === "object" && error !== null) {
		const message = (error as { message?: unknown }).message;
		if (typeof message === "string" && message.trim().length > 0) {
			return message === "Malformed Orpc Error Response" ? fallback : message;
		}
	}
	if (typeof error === "string" && error.trim().length > 0) {
		return error === "Malformed Orpc Error Response" ? fallback : error;
	}
	return fallback;
}
