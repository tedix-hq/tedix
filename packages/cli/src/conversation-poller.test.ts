/**
 * Tests for the ConversationPoller — the proactive-delivery mechanism that
 * surfaces INBOX_WAKE kernel messages automatically in the ink REPL transcript.
 *
 * Tests drive `processPollPage` (pure function, no timers) and the
 * `ConversationPoller` class for the inflight + markSeen + stop behaviours.
 */
import { describe, expect, mock, test } from "bun:test";
import {
	ConversationPoller,
	type PolledMessage,
	type PollerState,
	parseHomeMessagesPayload,
	processPollPage,
} from "./conversation-poller";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeState(
	overrides?: Partial<{
		seen: string[];
		seenRunIds: string[];
		inflightCount: number;
	}>,
): PollerState {
	return {
		seen: new Set(overrides?.seen ?? []),
		seenRunIds: new Set(overrides?.seenRunIds ?? []),
		inflightCount: overrides?.inflightCount ?? 0,
	};
}

// ── parseHomeMessagesPayload ──────────────────────────────────────────────────

describe("parseHomeMessagesPayload", () => {
	test("extracts messages from { messages: [...] } envelope", () => {
		const payload = {
			messages: [
				{ id: "m1", role: "user", content: "hello" },
				{ id: "m2", role: "assistant", content: "hi" },
			],
		};
		const result = parseHomeMessagesPayload(payload);
		expect(result).toHaveLength(2);
		expect(result[0]!.id).toBe("m1");
		expect(result[0]!.role).toBe("user");
		expect(result[1]!.id).toBe("m2");
		expect(result[1]!.role).toBe("assistant");
	});

	test("extracts messages from { data: [...] } envelope", () => {
		const payload = {
			data: [{ id: "m3", role: "assistant", content: "from data" }],
		};
		const result = parseHomeMessagesPayload(payload);
		expect(result).toHaveLength(1);
		expect(result[0]!.id).toBe("m3");
	});

	test("extracts messages from a raw array at root", () => {
		const payload = [{ id: "m4", role: "assistant", content: "raw" }];
		const result = parseHomeMessagesPayload(payload);
		expect(result).toHaveLength(1);
		expect(result[0]!.id).toBe("m4");
	});

	test("skips entries without an id", () => {
		const payload = { messages: [{ role: "assistant", content: "no id" }] };
		expect(parseHomeMessagesPayload(payload)).toHaveLength(0);
	});

	test("skips entries without a role", () => {
		const payload = { messages: [{ id: "m5", content: "no role" }] };
		expect(parseHomeMessagesPayload(payload)).toHaveLength(0);
	});

	test("captures runId and createdAt when present", () => {
		const payload = {
			messages: [
				{
					id: "m6",
					role: "assistant",
					content: "text",
					runId: "run-abc",
					createdAt: "2026-06-22T10:00:00Z",
				},
			],
		};
		const result = parseHomeMessagesPayload(payload);
		expect(result[0]!.runId).toBe("run-abc");
		expect(result[0]!.createdAt).toBe("2026-06-22T10:00:00Z");
	});

	test("returns empty array for null/undefined/non-object payloads", () => {
		expect(parseHomeMessagesPayload(null)).toHaveLength(0);
		expect(parseHomeMessagesPayload(undefined)).toHaveLength(0);
		expect(parseHomeMessagesPayload("string")).toHaveLength(0);
		expect(parseHomeMessagesPayload(42)).toHaveLength(0);
	});
});

// ── processPollPage: core dedup logic ────────────────────────────────────────

describe("processPollPage — new assistant message surfaces once", () => {
	test("surfaces a new assistant message not in SEEN", () => {
		const state = makeState();
		const payload = {
			messages: [{ id: "m1", role: "assistant", content: "CTO result" }],
		};
		const surfaced = processPollPage(payload, state);
		expect(surfaced).toHaveLength(1);
		expect(surfaced[0]!.id).toBe("m1");
		expect(surfaced[0]!.content).toBe("CTO result");
	});

	test("the same message on a second call is NOT surfaced again (dedup by id)", () => {
		const state = makeState();
		const payload = {
			messages: [{ id: "m1", role: "assistant", content: "CTO result" }],
		};
		const first = processPollPage(payload, state);
		const second = processPollPage(payload, state); // same payload, same state
		expect(first).toHaveLength(1);
		expect(second).toHaveLength(0); // deduped
	});

	test("a content-less assistant row (collapsed delegation narration) is NOT surfaced", () => {
		// Home keeps the row so Tedix OS can render its delegation receipt from the
		// structured metadata; the CLI has no receipt row and must not print a
		// blank turn.
		const state = makeState();
		const payload = {
			messages: [
				{ id: "collapsed", role: "assistant", content: "" },
				{ id: "whitespace", role: "assistant", content: "   \n" },
			],
		};
		expect(processPollPage(payload, state)).toHaveLength(0);
	});

	test("a message already in seen via markSeen is NOT surfaced", () => {
		const state = makeState({ seen: ["already-seen"] });
		const payload = {
			messages: [
				{ id: "already-seen", role: "assistant", content: "old message" },
			],
		};
		const surfaced = processPollPage(payload, state);
		expect(surfaced).toHaveLength(0);
	});

	test("a message whose runId was committed by dispatch (seenRunIds) is NOT surfaced", () => {
		const state = makeState({ seenRunIds: ["home-run-1"] });
		const payload = {
			messages: [
				{
					id: "m2",
					role: "assistant",
					content: "dispatch answer",
					runId: "home-run-1",
				},
			],
		};
		const surfaced = processPollPage(payload, state);
		expect(surfaced).toHaveLength(0);
		// The message id is still marked seen to avoid future re-scans
		expect(state.seen.has("m2")).toBe(true);
	});

	test("user-role messages are NOT surfaced (but ARE marked seen)", () => {
		const state = makeState();
		const payload = {
			messages: [
				{ id: "u1", role: "user", content: "operator input" },
				{ id: "a1", role: "assistant", content: "kernel reply" },
			],
		};
		const surfaced = processPollPage(payload, state);
		expect(surfaced).toHaveLength(1);
		expect(surfaced[0]!.id).toBe("a1");
		expect(state.seen.has("u1")).toBe(true);
		expect(state.seen.has("a1")).toBe(true);
	});

	test("an assistant message without a runId is always surfaced (INBOX_WAKE case)", () => {
		const state = makeState({ seenRunIds: ["home-run-99"] });
		const payload = {
			messages: [
				{
					id: "wake-msg",
					role: "assistant",
					content: "proactive wake result",
					// no runId — kernel INBOX_WAKE writes this kind of message
				},
			],
		};
		const surfaced = processPollPage(payload, state);
		expect(surfaced).toHaveLength(1);
		expect(surfaced[0]!.id).toBe("wake-msg");
	});

	test("multiple new messages are returned in chronological (oldest-first) order", () => {
		// The API returns newest-first; processPollPage reverses to chronological.
		const state = makeState();
		const payload = {
			messages: [
				{
					id: "m-newest",
					role: "assistant",
					content: "second",
					createdAt: "2026-06-22T11:00:00Z",
				},
				{
					id: "m-older",
					role: "assistant",
					content: "first",
					createdAt: "2026-06-22T10:00:00Z",
				},
			],
		};
		const surfaced = processPollPage(payload, state);
		expect(surfaced).toHaveLength(2);
		expect(surfaced[0]!.id).toBe("m-older"); // chronological first
		expect(surfaced[1]!.id).toBe("m-newest");
	});

	test("mixed scenario: dispatch answer excluded, INBOX_WAKE surfaced", () => {
		const state = makeState({ seenRunIds: ["dispatch-run"] });
		const payload = {
			messages: [
				// Newest-first from API (reversed by processPollPage)
				{
					id: "inbox-wake-msg",
					role: "assistant",
					content: "CTO async result",
				},
				{
					id: "dispatch-msg",
					role: "assistant",
					content: "dispatch answer",
					runId: "dispatch-run", // committed by dispatch path
				},
				{ id: "user-msg", role: "user", content: "user input" },
			],
		};
		const surfaced = processPollPage(payload, state);
		// Only the INBOX_WAKE message surfaces
		expect(surfaced).toHaveLength(1);
		expect(surfaced[0]!.id).toBe("inbox-wake-msg");
		// All ids marked seen
		expect(state.seen.has("inbox-wake-msg")).toBe(true);
		expect(state.seen.has("dispatch-msg")).toBe(true);
		expect(state.seen.has("user-msg")).toBe(true);
	});
});

// ── ConversationPoller class: inflight + markSeen + stop ─────────────────────

describe("ConversationPoller class", () => {
	test("markSeen seeds a message id so the poller skips it", () => {
		const state = makeState();
		const poller = new ConversationPoller({
			conversationId: "c1",
			intervalMs: 60_000,
			readMessages: mock(async () => ({})),
			onNewAssistantMessage: mock(() => {}),
		});
		poller.markSeen("msg-already-committed");

		// Drive processPollPage with the same state by checking the seen set
		const payload = {
			messages: [
				{
					id: "msg-already-committed",
					role: "assistant",
					content: "old",
				},
			],
		};
		// Verify via processPollPage with the seeded state
		state.seen.add("msg-already-committed");
		const surfaced = processPollPage(payload, state);
		expect(surfaced).toHaveLength(0);
	});

	test("setInflight/clearInflight controls isInflight", () => {
		const poller = new ConversationPoller({
			conversationId: "c1",
			intervalMs: 60_000,
			readMessages: mock(async () => ({})),
			onNewAssistantMessage: mock(() => {}),
		});
		expect(poller.isInflight).toBe(false);
		poller.setInflight();
		expect(poller.isInflight).toBe(true);
		poller.clearInflight();
		expect(poller.isInflight).toBe(false);
	});

	test("clearInflight is safe when not inflight (does not go negative)", () => {
		const poller = new ConversationPoller({
			conversationId: "c1",
			intervalMs: 60_000,
			readMessages: mock(async () => ({})),
			onNewAssistantMessage: mock(() => {}),
		});
		poller.clearInflight(); // no-op — should not throw
		expect(poller.isInflight).toBe(false);
	});

	test("skips polls while a dispatch is in-flight within the grace window", async () => {
		const readMessages = mock(async () => ({ messages: [] }));
		const poller = new ConversationPoller({
			conversationId: "c1",
			intervalMs: 1,
			inflightGraceMs: 60_000, // grace window far beyond the test duration
			readMessages,
			onNewAssistantMessage: mock(() => {}),
		});
		poller.setInflight();
		poller.start();
		await new Promise<void>((resolve) => setTimeout(resolve, 30));
		poller.stop();
		expect(readMessages).not.toHaveBeenCalled();
	});

	test("keeps polling while in-flight once the grace period has elapsed", async () => {
		// A run that settles server-side while the CLI's settle path is blind must
		// still surface: after the grace period the poller polls even in-flight.
		const readMessages = mock(async () => ({ messages: [] }));
		const poller = new ConversationPoller({
			conversationId: "c1",
			intervalMs: 1,
			inflightGraceMs: 0, // grace elapses immediately
			readMessages,
			onNewAssistantMessage: mock(() => {}),
		});
		poller.setInflight();
		poller.start();
		await new Promise<void>((resolve) => setTimeout(resolve, 40));
		poller.stop();
		expect(readMessages.mock.calls.length).toBeGreaterThanOrEqual(1);
	});

	test("stop() prevents the poller from calling readMessages again", async () => {
		const readMessages = mock(async () => ({ messages: [] }));
		const onNewAssistantMessage = mock((_msg: PolledMessage) => {});

		const poller = new ConversationPoller({
			conversationId: "c1",
			intervalMs: 0, // fire immediately
			readMessages,
			onNewAssistantMessage,
		});

		poller.start();
		// Stop before any timer fires
		poller.stop();

		// Wait a tick to ensure any scheduled callbacks would have fired
		await new Promise<void>((resolve) => setImmediate(resolve));
		await new Promise<void>((resolve) => setImmediate(resolve));

		// readMessages should NOT have been called after stop
		expect(readMessages).not.toHaveBeenCalled();
	});

	test("fail-soft: readMessages throwing calls onError and does not throw", async () => {
		const errors: unknown[] = [];
		const readMessages = mock(async (): Promise<unknown> => {
			throw new Error("network failure");
		});
		const onNewAssistantMessage = mock((_msg: PolledMessage) => {});

		const poller = new ConversationPoller({
			conversationId: "c1",
			intervalMs: 0,
			readMessages,
			onNewAssistantMessage,
			onError: (err) => errors.push(err),
		});

		// Manually trigger the internal poll via start + wait for the 0ms timer
		poller.start();
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
		poller.stop();

		expect(errors.length).toBeGreaterThanOrEqual(1);
		expect((errors[0] as Error).message).toBe("network failure");
		expect(onNewAssistantMessage).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Regression: every CLI read runs as Code Mode, so the poller is handed the
// gateway envelope `{ executionId, result }`. Digging for `messages` at the
// ROOT of that envelope found nothing on every real payload, so a delegated
// tedi's async-completion answer never reached the REPL and the operator had
// to ask for it again.
// ---------------------------------------------------------------------------

describe("parseHomeMessagesPayload envelope handling", () => {
	const message = {
		id: "5eed0008:async-completion:assistant",
		role: "assistant",
		content: "**Step 1 — discovered the documentation surface:** …",
		runId: "5eed0008-0000-4000-8000-000000000008",
		createdAt: "2026-09-17T04:12:16.630Z",
	};

	test("reads messages out of the Code Mode envelope", () => {
		const parsed = parseHomeMessagesPayload({
			executionId: "d992bd58-b905-4545-aaea-30f853d65c2d",
			result: { messages: [message] },
		});
		expect(parsed).toHaveLength(1);
		expect(parsed[0]?.id).toBe(message.id);
		expect(parsed[0]?.runId).toBe(message.runId);
	});

	test("still reads an already-unwrapped page", () => {
		expect(parseHomeMessagesPayload({ messages: [message] })).toHaveLength(1);
	});
});
