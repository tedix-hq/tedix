import { describe, expect, it } from "vite-plus/test";
import { CapnOutcomeUnknownError } from "./capn-chat-machine";
import {
	carryProvisionalFirstTurn,
	emptyProvisionalSends,
	hasProvisionalSend,
	isUnknownSendOutcome,
	listProvisionalSends,
	type ProvisionalSendAction,
	type ProvisionalSendMap,
	provisionalSendMessageId,
	reduceProvisionalSends,
	takeCarriedProvisionalFirstTurn,
} from "./provisional-send";

const KEY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_KEY = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONVERSATION_ID = "home:main";

function fold(
	actions: ProvisionalSendAction[],
	initial: ProvisionalSendMap = emptyProvisionalSends(),
): ProvisionalSendMap {
	return actions.reduce(reduceProvisionalSends, initial);
}

function send(
	overrides: Partial<Extract<ProvisionalSendAction, { type: "send" }>> = {},
): ProvisionalSendAction {
	return {
		type: "send",
		idempotencyKey: KEY,
		content: "ship it",
		conversationId: CONVERSATION_ID,
		at: "2026-08-16T10:00:00.000Z",
		...overrides,
	};
}

describe("provisionalSendMessageId", () => {
	it("is the exact id the canonical read returns for the user turn", () => {
		// execution-proposals.ts: `const runId = input.idempotencyKey ?? uuid()`
		// then `const userMessageId = `${runId}:input``.
		expect(provisionalSendMessageId(KEY)).toBe(`${KEY}:input`);
	});
});

describe("the send lifecycle", () => {
	it("opens in `sending` with attempt 1 and the durable id already bound", () => {
		const state = fold([send()]);
		const entry = state.get(KEY);
		expect(entry).toMatchObject({
			state: "sending",
			attempts: 1,
			content: "ship it",
			messageId: `${KEY}:input`,
			conversationId: CONVERSATION_ID,
			error: null,
		});
	});

	it("moves sending → outcome_unknown without asserting failure or success", () => {
		const state = fold([
			send(),
			{ type: "unknown", idempotencyKey: KEY, error: "socket died" },
		]);
		expect(state.get(KEY)?.state).toBe("outcome_unknown");
		expect(state.get(KEY)?.error).toBe("socket died");
		// The entry SURVIVES: dropping it would assert a not-sent nobody knows.
		expect(state.size).toBe(1);
	});

	it("drops the entry on a rejection, which is a KNOWN not-sent", () => {
		const state = fold([send(), { type: "rejected", idempotencyKey: KEY }]);
		expect(state.size).toBe(0);
	});
});

describe("exactly-once reconciliation", () => {
	it("keeps a same-key retry on ONE entry, however many times it is retried", () => {
		const state = fold([
			send(),
			{ type: "unknown", idempotencyKey: KEY, error: "socket died" },
			send({ at: "2026-08-16T10:00:05.000Z" }),
			{ type: "unknown", idempotencyKey: KEY, error: "socket died again" },
			send({ at: "2026-08-16T10:00:09.000Z" }),
		]);
		expect(state.size).toBe(1);
		expect(state.get(KEY)?.attempts).toBe(3);
		expect(state.get(KEY)?.state).toBe("sending");
		// The retry keeps its ORIGINAL transcript position, not the retry instant.
		expect(state.get(KEY)?.createdAt).toBe("2026-08-16T10:00:00.000Z");
	});

	it("retires exactly the entry whose durable row landed", () => {
		const state = fold([
			send(),
			send({ idempotencyKey: OTHER_KEY, content: "and this" }),
			{
				type: "reconcile",
				durableMessageIds: new Set([provisionalSendMessageId(KEY)]),
			},
		]);
		expect(state.has(KEY)).toBe(false);
		expect(state.has(OTHER_KEY)).toBe(true);
	});

	it("retires an unknown-outcome entry once its durable row appears", () => {
		// The first attempt WAS accepted after all: the transcript proves it, so
		// the unconfirmed bubble must go rather than linger beside the real row.
		const state = fold([
			send(),
			{ type: "unknown", idempotencyKey: KEY, error: "socket died" },
			{
				type: "reconcile",
				durableMessageIds: new Set([provisionalSendMessageId(KEY)]),
			},
		]);
		expect(state.size).toBe(0);
	});

	it("returns the SAME reference when a reconcile covers nothing", () => {
		const opened = fold([send()]);
		const after = reduceProvisionalSends(opened, {
			type: "reconcile",
			durableMessageIds: new Set(["some-other-message"]),
		});
		expect(after).toBe(opened);
	});
});

describe("key retirement (silent-drop guard)", () => {
	// The idempotency key IS the run id, and the durable event id is derived
	// from it and inserted with onConflictDoNothing. So reusing a key whose row
	// already landed makes the server DISCARD the new message's content with no
	// error anywhere — the operator's message just disappears. The overlay is
	// retired by `reconcile`, which is exactly when the key must stop being
	// reusable, INCLUDING for a send that was left outcome_unknown and turned
	// out to have been accepted.
	it("retires an outcome-unknown entry once its durable row appears", () => {
		const key = "11111111-1111-4111-8111-111111111111";
		let state = reduceProvisionalSends(emptyProvisionalSends(), {
			type: "send",
			idempotencyKey: key,
			content: "first message",
			conversationId: null,
			at: "2026-08-17T00:00:00.000Z",
		});
		state = reduceProvisionalSends(state, {
			type: "unknown",
			idempotencyKey: key,
			error: "socket died",
		});
		expect(state.get(key)?.state).toBe("outcome_unknown");

		state = reduceProvisionalSends(state, {
			type: "reconcile",
			durableMessageIds: new Set([provisionalSendMessageId(key)]),
		});
		// Gone: the durable row is the authority, whatever state the overlay held.
		expect(state.size).toBe(0);
		expect(hasProvisionalSend(state, key)).toBe(false);
	});
});

describe("conversation binding", () => {
	it("carries a first-turn bubble across the workspace route remount once", () => {
		carryProvisionalFirstTurn(
			"home:os:prepared-thread",
			send({ conversationId: "home:os:prepared-thread" }) as Extract<
				ProvisionalSendAction,
				{ type: "send" }
			>,
		);
		expect(
			listProvisionalSends(
				takeCarriedProvisionalFirstTurn("home:os:prepared-thread"),
				"home:os:prepared-thread",
			),
		).toHaveLength(1);
		expect(
			takeCarriedProvisionalFirstTurn("home:os:prepared-thread").size,
		).toBe(0);
	});

	it("adopts the id a fresh thread learned from the enqueue response", () => {
		const state = fold([
			send({ conversationId: null }),
			{ type: "adopt", conversationId: "home:os:new-thread" },
		]);
		expect(state.get(KEY)?.conversationId).toBe("home:os:new-thread");
	});

	it("never re-homes an entry that already knows its conversation", () => {
		const state = fold([
			send(),
			{ type: "adopt", conversationId: "home:os:other" },
		]);
		expect(state.get(KEY)?.conversationId).toBe(CONVERSATION_ID);
	});

	it("lists only this conversation's turns, and never another thread's", () => {
		const state = fold([
			send(),
			send({
				idempotencyKey: OTHER_KEY,
				conversationId: "home:os:elsewhere",
				content: "not here",
			}),
		]);
		expect(
			listProvisionalSends(state, CONVERSATION_ID).map((row) => row.content),
		).toEqual(["ship it"]);
	});

	it("shows an unstamped turn in the fresh thread AND after it is named", () => {
		// The first send of a brand-new thread has no conversation id until the
		// enqueue answers, so the bubble must render across that transition
		// rather than blinking out when the route flips.
		const state = fold([send({ conversationId: null })]);
		expect(listProvisionalSends(state, null)).toHaveLength(1);
		expect(listProvisionalSends(state, "home:os:new-thread")).toHaveLength(1);
	});

	it("shows a target-bound first turn before the New route adopts its id", () => {
		// ChatThread mints the target id before enqueueing, but navigation cannot
		// adopt it until the response arrives. The provisional row must bridge
		// that interval instead of leaving only the composer spinner visible.
		const state = fold([
			send({ conversationId: "home:os:pending-new-thread" }),
		]);
		expect(
			listProvisionalSends(state, null, "home:os:pending-new-thread"),
		).toHaveLength(1);
		expect(listProvisionalSends(state, null)).toHaveLength(0);
	});

	it("clears every entry on a conversation switch", () => {
		expect(fold([send(), { type: "clear" }]).size).toBe(0);
	});
});

describe("hasProvisionalSend", () => {
	it("is false for a null key and for a retired entry", () => {
		const state = fold([send(), { type: "settled", idempotencyKey: KEY }]);
		expect(hasProvisionalSend(state, null)).toBe(false);
		expect(hasProvisionalSend(state, KEY)).toBe(false);
	});
});

describe("isUnknownSendOutcome", () => {
	it("recognizes the Cap'n lane's explicit unknown", () => {
		expect(
			isUnknownSendOutcome(new CapnOutcomeUnknownError(KEY, new Error("boom"))),
		).toBe(true);
	});

	it("treats a bare transport failure on the oRPC lane as unknown", () => {
		// This is the case the default lane used to title "Message not sent".
		expect(isUnknownSendOutcome(new TypeError("Failed to fetch"))).toBe(true);
	});

	it("treats a boundary refusal as a KNOWN not-sent", () => {
		expect(isUnknownSendOutcome({ code: "FORBIDDEN" })).toBe(false);
		expect(isUnknownSendOutcome({ code: "BAD_REQUEST" })).toBe(false);
		expect(isUnknownSendOutcome({ code: "TOO_MANY_REQUESTS" })).toBe(false);
	});

	it("keeps a server-side blow-up UNKNOWN, because it may follow admission", () => {
		expect(isUnknownSendOutcome({ code: "INTERNAL_SERVER_ERROR" })).toBe(true);
	});
});
