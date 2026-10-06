/**
 * Pure helpers for the operator-only `/__admin/agent-diag` and
 * `/__admin/dequeue` endpoints on {@link AgentTediDO}.
 *
 * These endpoints let an operator INSPECT and CLEAR a poison queued reflection
 * job in an isolate Durable Object (a Lifecycle job-queue item whose callback —
 * e.g. `onBridgeTurn` / `onLedgerMirror` / `onCompileDirectives` /
 * `onAuditCorpus` — fails every flush and blocks the queue) WITHOUT a full DO
 * rebind, which is otherwise the only recovery.
 *
 * The logic that touches the Agents SDK queue/schedule surface stays inline in
 * `do.ts` (it needs `this`). Only the auth predicate + payload shaping live
 * here so they can be unit-tested without a Worker harness.
 */

import { isServiceBinding, secureEqual } from "@tedix/worker-kit/request-auth";

/** Headers the admin-route guard reads. Mirrors `do.ts` `/__admin/workflow-*`. */
export interface AdminAuthInput {
	/** Inbound request carrying service-binding or shared-secret headers. */
	request: Request;
	/** `env.SECRETS_MASTER_KEY` (the shared secret to match). */
	masterKey: string | undefined;
}

/**
 * Operator-only guard, byte-for-byte identical in intent to the existing
 * `/__admin/workflow-list` + `/__admin/workflow-restart` guard:
 *   - a shared-secret `X-Tedix-Admin-Token` that matches `env.SECRETS_MASTER_KEY`, OR
 *   - a trusted service binding (`isServiceBinding`).
 *
 * Fail-closed: with no master key configured the token path can never pass, so
 * the only way in is a trusted service binding.
 */
export async function isAdminAuthorized(
	input: AdminAuthInput,
): Promise<boolean> {
	const tokenMatches = await secureEqual(
		input.request.headers.get("X-Tedix-Admin-Token"),
		input.masterKey,
	);
	const bindingAllowed = isServiceBinding(input.request.headers);
	return tokenMatches || bindingAllowed;
}

/** A single queued task, summarized for the diagnostic snapshot. */
export interface QueuedCallbackSummary {
	id: string;
	callback: string;
	createdAt: number;
}

/** Raw Lifecycle queue-item row shape (only the columns we read). */
export interface QueueRow {
	id: string;
	callback: string;
	created_at: number;
}

/**
 * Shape raw queue rows into a depth + a bounded list of recent queued callback
 * names (newest first). Bounded so a backed-up queue can't bloat the response.
 */
export function summarizeQueue(
	rows: QueueRow[],
	limit = 50,
): { depth: number; recent: QueuedCallbackSummary[] } {
	const recent = [...rows]
		.sort((a, b) => b.created_at - a.created_at)
		.slice(0, Math.max(0, limit))
		.map((r) => ({ id: r.id, callback: r.callback, createdAt: r.created_at }));
	return { depth: rows.length, recent };
}

/** Body of `POST /__admin/dequeue`. */
export interface DequeueRequest {
	/** If set, only drain queued tasks for this callback; else drain ALL. */
	callback?: string;
	/** If true, also cancel every current schedule. */
	cancelSchedules?: boolean;
}

/**
 * Validate + normalize a dequeue request body. Returns a typed request or an
 * error string (never throws). Unknown / extra fields are ignored.
 */
export function parseDequeueBody(
	raw: unknown,
): { ok: true; value: DequeueRequest } | { ok: false; error: string } {
	if (raw == null || typeof raw !== "object") {
		// An empty/absent body means "drain everything" — that's valid.
		return { ok: true, value: {} };
	}
	const obj = raw as Record<string, unknown>;
	const out: DequeueRequest = {};
	if (obj.callback !== undefined) {
		if (typeof obj.callback !== "string") {
			return { ok: false, error: "callback must be a string" };
		}
		const trimmed = obj.callback.trim();
		if (trimmed.length === 0) {
			return { ok: false, error: "callback must not be empty" };
		}
		out.callback = trimmed;
	}
	if (obj.cancelSchedules !== undefined) {
		if (typeof obj.cancelSchedules !== "boolean") {
			return { ok: false, error: "cancelSchedules must be a boolean" };
		}
		out.cancelSchedules = obj.cancelSchedules;
	}
	return { ok: true, value: out };
}
