/**
 * Pure runtime-error predicates for the tedix CLI. home-client.ts uses
 * connection/auth classification; home-submission.ts uses recoverable-turn
 * classification to decide whether a stalled submission can resume.
 */

import { errorMessage } from "@tedix/worker-kit/error-message";

const CONNECTION_ERROR_RE =
	/connection closed|connectionclosed|transport closed|not connected|network|timeout|terminated|aborted|ECONN|EPIPE|socket hang up|fetch failed|stream|503|502|D1_ERROR|D1 DB is overloaded|Requests queued for too long/i;

/**
 * True for transport/connection-level failures that a stale shared MCP
 * connection can self-heal by reconnecting — as opposed to JSON-RPC/validation/
 * auth errors, which must propagate without resetting the client.
 */
export function isConnectionError(error: unknown): boolean {
	return CONNECTION_ERROR_RE.test(errorMessage(error));
}

const AUTH_ERROR_RE =
	/\b401\b|unauthorized|invalid token|invalid or expired|token expired|authentication failed/i;

/**
 * A hard authentication failure (bad/expired token) — surfaced as 401,
 * "Unauthorized", "Invalid token", "Token expired", or "Authentication failed".
 * Distinct from a transient connection error so callers can fast-fail with a
 * re-login hint instead of the long retry/timeout.
 *
 * Note: 403 (forbidden / scope-denial / rate-limit) is intentionally excluded —
 * a 403 does NOT mean the token is bad, so it must not trigger re-login.
 */
export function isAuthError(error: unknown): boolean {
	return AUTH_ERROR_RE.test(errorMessage(error));
}

/**
 * A stalled/dropped turn whose durable run may still be recoverable. Recognizes
 * the blocking ask timeout (`ASK_HOME_TIMEOUT`), JSON-RPC request timeouts
 * (`-32001` / "request timed out" / "timed out"), and any transport/connection
 * drop (`isConnectionError`).
 */
export function isRecoverableTurnError(error: unknown): boolean {
	const message = errorMessage(error);
	if (message.includes("ASK_HOME_TIMEOUT")) return true;
	if (/-?32001|request timed out|timed out/i.test(message)) return true;
	return isConnectionError(error);
}
