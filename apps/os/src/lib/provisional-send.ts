/**
 * The provisional user-turn plane: a temporary message that exists from the
 * instant the operator hits Send until the DURABLE row for it lands.
 *
 * Why a plane at all. The composer used to render nothing between submit and
 * the enqueue response — the bubble was synthesized from the RESPONSE
 * (`userMessageFromEnqueue`), so a slow kernel turn showed an empty transcript
 * and a spinner, and a transport death mid-send showed a banner and no trace of
 * the message that may well have been accepted.
 *
 * ---------------------------------------------------------------------------
 * WHY IT RECONCILES EXACTLY ONCE
 * ---------------------------------------------------------------------------
 * `apps/api/src/rpc/routers/kernel-runtime/execution-proposals.ts` opens with
 *
 *     const runId = input.idempotencyKey ?? crypto.randomUUID();
 *     const userMessageId = `${runId}:input`;
 *
 * so the key the client mints IS the run id, and the durable user row's id is a
 * pure function of it. Every write behind the enqueue is `onConflictDoNothing`
 * on a deterministic id, which makes a SAME-KEY resend converge onto the same
 * rows rather than creating new ones.
 *
 * This plane keys on that same key. Consequences, all deliberate:
 *
 * - A retry after a failure or an unknown outcome reuses the key, so it lands
 *   on the SAME entry (`attempts` increments) — never a second bubble, however
 *   many times it is retried.
 * - `messageId` is `{key}:input`, EXACTLY the id the canonical read returns, so
 *   reconciliation is set membership, not a heuristic match on content or time.
 * - Reconciliation REMOVES the entry. A provisional overlay never coexists with
 *   its durable counterpart, which is the same swap-on-durable rule
 *   `visibleOverlays` applies to the assistant side.
 *
 * ---------------------------------------------------------------------------
 * THE STATES, AND WHAT EACH ONE IS ALLOWED TO CLAIM
 * ---------------------------------------------------------------------------
 * - `sending` — the call is in flight. Claims nothing about the server.
 * - `outcome_unknown` — the call died without an answer. The kernel may or may
 *   not have accepted it. This may NOT be rendered as failure and may NOT be
 *   rendered as sent; the entry stays visible precisely because dropping it
 *   would assert a not-sent the client cannot know.
 * - `rejected` — the server ANSWERED and refused. A known not-sent, so the
 *   entry is dropped and the draft goes back to the composer for a retry.
 *
 * There is no `durable` state: reaching durable is the entry's removal. Storing
 * it would let a stale provisional row outlive the authoritative one, which is
 * exactly the invariant this plane exists to hold.
 *
 * Pure and ephemeral: no React, no storage. A reload clears every entry, which
 * is correct — the durable rows come back from `readMessages`, and the DRAFT
 * survives separately in localStorage.
 */

import { isOutcomeUnknown } from "@/lib/capn-chat-machine";
import { orpcErrorCode } from "@/lib/orpc-error";

export type ProvisionalSendState = "sending" | "outcome_unknown" | "rejected";

/**
 * oRPC codes that mean the kernel REFUSED the enqueue at its boundary, before
 * any run could be admitted: validation, authorization, addressing, rate. A
 * refusal decided there is a KNOWN not-sent.
 *
 * Everything NOT in this set stays unknown — including a bare transport error
 * with no code at all, and including `INTERNAL_SERVER_ERROR`, which may well
 * have been raised AFTER the turn was admitted. The asymmetry is deliberate:
 * over-claiming "not sent" invites a duplicate the operator did not intend,
 * while "may not have been sent" is true in both worlds. A same-key retry is
 * exactly-once either way, so the conservative reading costs nothing.
 */
const KNOWN_NOT_SENT_CODES: ReadonlySet<string> = new Set([
	"BAD_REQUEST",
	"UNAUTHORIZED",
	"FORBIDDEN",
	"NOT_FOUND",
	"METHOD_NOT_SUPPORTED",
	"CONFLICT",
	"PAYLOAD_TOO_LARGE",
	"UNSUPPORTED_MEDIA_TYPE",
	"UNPROCESSABLE_CONTENT",
	"TOO_MANY_REQUESTS",
]);

/**
 * Did the send's outcome stay UNKNOWN?
 *
 * `CapnOutcomeUnknownError` is the Cap'n lane's explicit signal (the socket
 * died with the enqueue in flight). The oRPC lane had no equivalent, so a fetch
 * that died mid-request was titled "Message not sent" as fact; this closes that
 * gap on the DEFAULT lane by classifying the error code instead.
 */
export function isUnknownSendOutcome(error: unknown): boolean {
	if (isOutcomeUnknown(error)) return true;
	const code = orpcErrorCode(error);
	return code === null || !KNOWN_NOT_SENT_CODES.has(code);
}

export type ProvisionalSend = {
	/** The enqueue idempotency key, which IS the run id server-side. */
	idempotencyKey: string;
	/** `{idempotencyKey}:input` — the exact id the canonical read returns. */
	messageId: string;
	/** Null until a brand-new thread learns its id from the enqueue response. */
	conversationId: string | null;
	content: string;
	state: ProvisionalSendState;
	/** Same-key attempts. 1 on the first send; a retry increments in place. */
	attempts: number;
	/** Server or transport message for the non-`sending` states. */
	error: string | null;
	/** Client clock — provisional rows sort after every durable row. */
	createdAt: string;
};

export type ProvisionalSendMap = ReadonlyMap<string, ProvisionalSend>;

const carriedFirstTurns = new Map<string, ProvisionalSendMap>();
const CARRIED_FIRST_TURN_CAPACITY = 20;

/** Carry one optimistic first turn across the `/chat` -> Workspace remount. */
export function carryProvisionalFirstTurn(
	conversationId: string,
	action: Extract<ProvisionalSendAction, { type: "send" }>,
): void {
	carriedFirstTurns.delete(conversationId);
	carriedFirstTurns.set(
		conversationId,
		reduceProvisionalSends(emptyProvisionalSends(), action),
	);
	while (carriedFirstTurns.size > CARRIED_FIRST_TURN_CAPACITY) {
		carriedFirstTurns.delete(carriedFirstTurns.keys().next().value!);
	}
}

/** A route remount consumes the overlay; durable reconciliation owns it next. */
export function takeCarriedProvisionalFirstTurn(
	conversationId: string | null,
): ProvisionalSendMap {
	if (!conversationId) return emptyProvisionalSends();
	const carried = carriedFirstTurns.get(conversationId);
	if (!carried) return emptyProvisionalSends();
	carriedFirstTurns.delete(conversationId);
	return carried;
}

export function emptyProvisionalSends(): ProvisionalSendMap {
	return new Map();
}

/**
 * The durable transcript id an idempotency key resolves to. The ONE place this
 * join is built — never re-string-concatenated at a call site.
 */
export function provisionalSendMessageId(idempotencyKey: string): string {
	return `${idempotencyKey}:input`;
}

export type ProvisionalSendAction =
	| {
			type: "send";
			idempotencyKey: string;
			content: string;
			conversationId: string | null;
			at: string;
	  }
	| { type: "unknown"; idempotencyKey: string; error: string }
	| { type: "rejected"; idempotencyKey: string }
	| { type: "settled"; idempotencyKey: string }
	/** A durable page landed: every entry it covers retires. */
	| { type: "reconcile"; durableMessageIds: ReadonlySet<string> }
	/** A fresh thread learned its id; unstamped entries adopt it. */
	| { type: "adopt"; conversationId: string }
	| { type: "clear" };

/**
 * Pure fold. Returns the SAME reference when nothing changed, so a re-delivered
 * transcript page costs zero renders.
 */
export function reduceProvisionalSends(
	state: ProvisionalSendMap,
	action: ProvisionalSendAction,
): ProvisionalSendMap {
	switch (action.type) {
		case "send": {
			const existing = state.get(action.idempotencyKey);
			const next = new Map(state);
			next.set(action.idempotencyKey, {
				idempotencyKey: action.idempotencyKey,
				messageId: provisionalSendMessageId(action.idempotencyKey),
				// A retry keeps the conversation it was first sent to; only a
				// still-unstamped entry takes the caller's (possibly null) id.
				conversationId: existing?.conversationId ?? action.conversationId,
				content: action.content,
				state: "sending",
				attempts: (existing?.attempts ?? 0) + 1,
				error: null,
				// Retries keep their original position in the transcript.
				createdAt: existing?.createdAt ?? action.at,
			});
			return next;
		}
		case "unknown": {
			const existing = state.get(action.idempotencyKey);
			if (existing === undefined) return state;
			if (
				existing.state === "outcome_unknown" &&
				existing.error === action.error
			) {
				return state;
			}
			const next = new Map(state);
			next.set(action.idempotencyKey, {
				...existing,
				state: "outcome_unknown",
				error: action.error,
			});
			return next;
		}
		case "rejected":
		case "settled": {
			// Both are terminal for the OVERLAY. `settled` retires it because the
			// durable row now exists; `rejected` retires it because the server
			// answered that it does not, and the draft returns to the composer.
			if (!state.has(action.idempotencyKey)) return state;
			const next = new Map(state);
			next.delete(action.idempotencyKey);
			return next;
		}
		case "reconcile": {
			if (state.size === 0) return state;
			let next: Map<string, ProvisionalSend> | null = null;
			for (const entry of state.values()) {
				if (!action.durableMessageIds.has(entry.messageId)) continue;
				next ??= new Map(state);
				next.delete(entry.idempotencyKey);
			}
			return next ?? state;
		}
		case "adopt": {
			let next: Map<string, ProvisionalSend> | null = null;
			for (const entry of state.values()) {
				if (entry.conversationId !== null) continue;
				next ??= new Map(state);
				next.set(entry.idempotencyKey, {
					...entry,
					conversationId: action.conversationId,
				});
			}
			return next ?? state;
		}
		case "clear":
			return state.size === 0 ? state : new Map();
	}
}

/**
 * Renderable provisional turns for one conversation, oldest first.
 *
 * A `null` conversation id matches the not-yet-created thread, which is the
 * state a first send is in until the enqueue response names the conversation.
 */
export function listProvisionalSends(
	state: ProvisionalSendMap,
	conversationId: string | null,
	pendingNewConversationId: string | null = null,
): ProvisionalSend[] {
	// A first send already has the explicit id that will become the route, while
	// the synthetic New view still has no `conversationId` prop. Treat that
	// locally minted id as the active thread until navigation catches up.
	const activeConversationId = conversationId ?? pendingNewConversationId;
	const rows: ProvisionalSend[] = [];
	for (const entry of state.values()) {
		if (
			entry.conversationId !== null &&
			entry.conversationId !== activeConversationId
		) {
			continue;
		}
		rows.push(entry);
	}
	return rows.sort(
		(a, b) =>
			Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
			(a.idempotencyKey < b.idempotencyKey ? -1 : 1),
	);
}

/**
 * Is there a live provisional turn holding this key? The composer reads this to
 * decide whether the draft belongs in the textarea or in the bubble.
 */
export function hasProvisionalSend(
	state: ProvisionalSendMap,
	idempotencyKey: string | null,
): boolean {
	return idempotencyKey !== null && state.has(idempotencyKey);
}

/** Human-facing status text. Each string states EXACTLY what is known. */
export const PROVISIONAL_SEND_LABEL: Record<ProvisionalSendState, string> = {
	sending: "Sending…",
	outcome_unknown: "Delivery unconfirmed",
	rejected: "Not sent",
};
