/** Behavioral coverage for the transport-neutral overlay reducer. */

import { describe, expect, it } from "vite-plus/test";
import {
	applyOverlayEvent,
	createOverlayState,
	listOverlays,
	readStreamedPhase,
	visibleOverlays,
} from "./overlay-state";
import type { RuntimeStreamEvent } from "@tedix/api-contract/schemas/runtime-submissions";

const RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONVERSATION_ID = "home:main";

function event(
	overrides: Partial<RuntimeStreamEvent> = {},
): RuntimeStreamEvent {
	return {
		id: "evt-1",
		kind: "message.delta",
		conversationId: CONVERSATION_ID,
		runId: RUN_ID,
		createdAt: "2026-08-13T10:00:00.000Z",
		...overrides,
	};
}

function delta(
	sequence: number,
	chunk: string,
	overrides: Partial<RuntimeStreamEvent> = {},
): RuntimeStreamEvent {
	return event({
		id: `${RUN_ID}:answer-delta:${sequence}`,
		kind: "message.delta",
		sequence,
		delta: chunk,
		payload: {
			role: "assistant",
			channel: "home",
			content: chunk,
			metadata: { homeSubject: true, homeRunId: RUN_ID },
		},
		...overrides,
	});
}

describe("applyOverlayEvent / listOverlays", () => {
	it("reassembles deltas in sequence order even when they arrive out of order", () => {
		const state = createOverlayState();
		applyOverlayEvent(state, delta(2, " world"));
		applyOverlayEvent(state, delta(0, "Hello"));
		applyOverlayEvent(state, delta(1, ","));
		const [overlay] = listOverlays(state);
		expect(overlay?.text).toBe("Hello, world");
		expect(overlay?.key).toBe(`${RUN_ID}:assistant`);
		expect(overlay?.finalized).toBe(false);
	});

	it("treats a re-delivered delta as a no-op", () => {
		const state = createOverlayState();
		expect(applyOverlayEvent(state, delta(0, "Hi"))).toBe(true);
		expect(applyOverlayEvent(state, delta(0, "Hi"))).toBe(false);
		expect(listOverlays(state)[0]?.text).toBe("Hi");
	});

	it("a higher streamAttempt (redriven turn) resets the chunk namespace", () => {
		const state = createOverlayState();
		applyOverlayEvent(state, delta(0, "first attempt "));
		applyOverlayEvent(state, delta(1, "text"));
		applyOverlayEvent(
			state,
			delta(0, "redriven ", {
				payload: {
					role: "assistant",
					channel: "home",
					content: "redriven ",
					metadata: { streamAttempt: 1 },
				},
			}),
		);
		expect(listOverlays(state)[0]?.text).toBe("redriven ");
		// a straggler from the old attempt is ignored
		expect(applyOverlayEvent(state, delta(2, "stale"))).toBe(false);
		expect(listOverlays(state)[0]?.text).toBe("redriven ");
	});

	it("message.completed swaps to the FULL canonical text and records the durable id", () => {
		const state = createOverlayState();
		applyOverlayEvent(state, delta(0, "The answer is"));
		const changed = applyOverlayEvent(
			state,
			event({
				id: `${RUN_ID}:assistant-completed`,
				kind: "message.completed",
				messageId: `${RUN_ID}:assistant`,
				payload: {
					role: "assistant",
					channel: "home",
					content:
						"The answer is 42 — with the trailing partial the deltas never carried.",
				},
			}),
		);
		expect(changed).toBe(true);
		const [overlay] = listOverlays(state);
		expect(overlay?.finalized).toBe(true);
		expect(overlay?.messageId).toBe(`${RUN_ID}:assistant`);
		expect(overlay?.text).toBe(
			"The answer is 42 — with the trailing partial the deltas never carried.",
		);
		// deltas never arrive after message.completed; a replayed one is ignored
		expect(applyOverlayEvent(state, delta(1, " 42"))).toBe(false);
		// re-delivered finalization is a no-op
		expect(
			applyOverlayEvent(
				state,
				event({
					kind: "message.completed",
					messageId: `${RUN_ID}:assistant`,
					payload: {
						role: "assistant",
						content:
							"The answer is 42 — with the trailing partial the deltas never carried.",
					},
				}),
			),
		).toBe(false);
	});

	it("keys convergence finalizations by the event's own runId + messageId", () => {
		const state = createOverlayState();
		applyOverlayEvent(state, delta(0, "converging"));
		applyOverlayEvent(
			state,
			event({
				kind: "message.completed",
				messageId: `${RUN_ID}:plan-convergence:assistant`,
				payload: { role: "assistant", content: "converged plan" },
			}),
		);
		const [overlay] = listOverlays(state);
		expect(overlay?.key).toBe(`${RUN_ID}:assistant`);
		expect(overlay?.messageId).toBe(`${RUN_ID}:plan-convergence:assistant`);
	});

	it("run.failed and run.canceled drop the overlay entirely", () => {
		const state = createOverlayState();
		applyOverlayEvent(state, delta(0, "half an answer"));
		expect(applyOverlayEvent(state, event({ kind: "run.failed" }))).toBe(true);
		expect(listOverlays(state)).toEqual([]);
		applyOverlayEvent(state, delta(0, "again"));
		applyOverlayEvent(state, event({ kind: "run.canceled" }));
		expect(listOverlays(state)).toEqual([]);
	});

	it("ignores non-assistant message.completed and events without a runId", () => {
		const state = createOverlayState();
		expect(
			applyOverlayEvent(
				state,
				event({ kind: "message.completed", runId: null, messageId: "x" }),
			),
		).toBe(false);
		expect(
			applyOverlayEvent(
				state,
				event({
					kind: "message.received",
					payload: { role: "user", content: "hi" },
				}),
			),
		).toBe(false);
		expect(listOverlays(state)).toEqual([]);
	});
});

describe("home-narration finalizations", () => {
	it("drops an overlay whose durable row the transcript never renders", () => {
		// The dispatch ack ("On it — delegating to CTO now…") is stamped
		// `homeNarration` and DROPPED by the server's narration collapse, so its
		// id never joins the transcript and the swap-on-durable rule can never
		// fire. Kept, the overlay outlives the turn and — because overlays render
		// below every durable row — pins itself under the delegated result that
		// lands minutes later.
		const state = createOverlayState();
		applyOverlayEvent(state, delta(0, "On it — delegating to CTO now."));
		expect(
			applyOverlayEvent(
				state,
				event({
					kind: "message.completed",
					messageId: `${RUN_ID}:assistant`,
					payload: {
						role: "assistant",
						content: "On it — delegating to CTO now.",
						metadata: { homeNarration: "delegation_ack" },
					},
				}),
			),
		).toBe(true);
		expect(listOverlays(state)).toEqual([]);
	});

	it("creates nothing for a narration turn that streamed no text", () => {
		const state = createOverlayState();
		expect(
			applyOverlayEvent(
				state,
				event({
					kind: "message.completed",
					messageId: `${RUN_ID}:assistant`,
					payload: {
						role: "assistant",
						content: "canceled",
						metadata: { homeNarration: "turn_canceled_delegated" },
					},
				}),
			),
		).toBe(false);
		expect(listOverlays(state)).toEqual([]);
	});

	it("still finalizes an ordinary assistant turn", () => {
		const state = createOverlayState();
		applyOverlayEvent(state, delta(0, "Here is "));
		applyOverlayEvent(
			state,
			event({
				kind: "message.completed",
				messageId: `${RUN_ID}:assistant`,
				payload: {
					role: "assistant",
					content: "Here is the answer",
					metadata: { homeSubject: true },
				},
			}),
		);
		expect(listOverlays(state)).toHaveLength(1);
		expect(listOverlays(state)[0]?.finalized).toBe(true);
	});
});

describe("visibleOverlays", () => {
	it("hides an overlay once the durable transcript contains its row", () => {
		const state = createOverlayState();
		applyOverlayEvent(state, delta(0, "Hello"));
		applyOverlayEvent(
			state,
			event({
				kind: "message.completed",
				messageId: `${RUN_ID}:assistant`,
				payload: { role: "assistant", content: "Hello there" },
			}),
		);
		const overlays = listOverlays(state);
		expect(visibleOverlays(overlays, new Set())).toHaveLength(1);
		expect(
			visibleOverlays(overlays, new Set([`${RUN_ID}:assistant`])),
		).toHaveLength(0);
	});

	it("hides an in-flight phase once a durable assistant row proves the run answered", () => {
		const state = createOverlayState();
		applyOverlayEvent(state, phase(0, "finalizing"));
		const overlays = listOverlays(state);
		expect(overlays).toHaveLength(1);
		expect(visibleOverlays(overlays, new Set(), new Set([RUN_ID]))).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Runtime phase channel (`message.phase`)
// ---------------------------------------------------------------------------

function phase(
	sequence: number,
	name: string,
	extra: Record<string, string> = {},
): RuntimeStreamEvent {
	return event({
		id: `${RUN_ID}:phase:${sequence}`,
		kind: "message.phase",
		sequence,
		// The Cap'n machine parses every frame through the strict
		// RuntimeStreamEventSchema, which strips unknown top-level keys, so
		// phase data must travel in `payload` to survive the wire.
		payload: { phase: name, ...extra },
	});
}

describe("message.phase", () => {
	it("reads a vocabulary phase from payload, with detail and start time", () => {
		expect(
			readStreamedPhase(
				phase(1, "using_tool", {
					detail: " gmail_send ",
					at: "2026-08-13T10:00:05.000Z",
				}),
			),
		).toEqual({
			phase: "using_tool",
			detail: "gmail_send",
			since: Date.parse("2026-08-13T10:00:05.000Z"),
			sequence: 1,
		});
		// No `at` → the event's own createdAt anchors the elapsed readout.
		expect(readStreamedPhase(phase(2, "planning"))?.since).toBe(
			Date.parse("2026-08-13T10:00:00.000Z"),
		);
		// Outside the vocabulary → ignored, never rendered as a label.
		expect(readStreamedPhase(phase(3, "invented"))).toBeNull();
		expect(readStreamedPhase(delta(0, "x"))).toBeNull();
	});

	it("keeps the newest phase per run and surfaces it as an overlay with no text", () => {
		const state = createOverlayState();
		expect(applyOverlayEvent(state, phase(1, "preparing_context"))).toBe(true);
		expect(applyOverlayEvent(state, phase(1, "preparing_context"))).toBe(false);
		expect(
			applyOverlayEvent(state, phase(3, "using_tool", { detail: "search" })),
		).toBe(true);
		// A stale (lower-sequence) re-delivery never regresses the label.
		expect(applyOverlayEvent(state, phase(2, "planning"))).toBe(false);
		expect(applyOverlayEvent(state, phase(4, "invented"))).toBe(false);

		const [overlay] = listOverlays(state);
		expect(overlay?.text).toBe("");
		expect(overlay?.phase).toMatchObject({
			phase: "using_tool",
			detail: "search",
		});
		expect(overlay?.finalized).toBe(false);
	});

	it("drops the phase on finalization and a phase-only run disappears", () => {
		const state = createOverlayState();
		applyOverlayEvent(state, phase(1, "generating"));
		expect(listOverlays(state)).toHaveLength(1);
		expect(applyOverlayEvent(state, event({ kind: "run.completed" }))).toBe(
			true,
		);
		expect(listOverlays(state)).toEqual([]);

		// With streamed text the overlay survives (the durable swap still owns
		// it) but carries no phase any more.
		const withText = createOverlayState();
		applyOverlayEvent(withText, delta(0, "Hello"));
		applyOverlayEvent(withText, phase(1, "finalizing"));
		applyOverlayEvent(withText, event({ kind: "run.completed" }));
		expect(listOverlays(withText)[0]).toMatchObject({
			text: "Hello",
			phase: null,
			finalized: true,
		});
	});
});

// ---------------------------------------------------------------------------
// Provisional planner rationale (`message.reasoning`)
// ---------------------------------------------------------------------------

function rationale(sequence: number, chunk: string): RuntimeStreamEvent {
	return event({
		id: `${RUN_ID}:rationale:${sequence}`,
		kind: "message.reasoning",
		sequence,
		delta: chunk,
		payload: {
			channel: "home",
			content: chunk,
			provisional: true,
			metadata: { homeSubject: true, homeRunId: RUN_ID },
		},
	});
}

describe("message.reasoning", () => {
	it("reassembles provisional rationale chunks and keeps them OUT of the answer", () => {
		const state = createOverlayState();
		expect(
			applyOverlayEvent(state, rationale(1, " between two projects")),
		).toBe(true);
		expect(
			applyOverlayEvent(state, rationale(0, "The request is ambiguous")),
		).toBe(true);
		// Re-delivery of the same sequence changes nothing.
		expect(
			applyOverlayEvent(state, rationale(0, "The request is ambiguous")),
		).toBe(false);
		const [overlay] = listOverlays(state);
		expect(overlay?.rationale).toBe(
			"The request is ambiguous between two projects",
		);
		// The rationale is never the answer.
		expect(overlay?.text).toBe("");
		expect(overlay?.finalized).toBe(false);
	});

	it("renders on a route that never streams an answer (the blank-screen case)", () => {
		const state = createOverlayState();
		applyOverlayEvent(state, phase(1, "planning"));
		applyOverlayEvent(state, rationale(0, "Delegating to the GitHub tedi"));
		const [overlay] = listOverlays(state);
		expect(overlay?.text).toBe("");
		expect(overlay?.rationale).toBe("Delegating to the GitHub tedi");
		expect(overlay?.phase).toMatchObject({ phase: "planning" });
	});

	it("is superseded by the settled answer and dropped on abort", () => {
		const settled = createOverlayState();
		applyOverlayEvent(settled, rationale(0, "thinking out loud"));
		applyOverlayEvent(settled, delta(0, "Hello"));
		applyOverlayEvent(
			settled,
			event({
				kind: "message.completed",
				messageId: "msg-1",
				payload: { role: "assistant", content: "Hello world" },
			}),
		);
		expect(listOverlays(settled)[0]).toMatchObject({
			text: "Hello world",
			rationale: "",
			finalized: true,
		});

		// A rationale-only run leaves nothing behind once it terminates.
		const aborted = createOverlayState();
		applyOverlayEvent(aborted, rationale(0, "thinking out loud"));
		expect(listOverlays(aborted)).toHaveLength(1);
		applyOverlayEvent(aborted, event({ kind: "run.canceled" }));
		expect(listOverlays(aborted)).toEqual([]);
	});

	it("ignores a rationale frame that arrives after finalization", () => {
		const state = createOverlayState();
		applyOverlayEvent(state, delta(0, "Answer"));
		applyOverlayEvent(state, event({ kind: "run.completed" }));
		expect(applyOverlayEvent(state, rationale(0, "late"))).toBe(false);
		expect(listOverlays(state)[0]?.rationale).toBe("");
	});
});
