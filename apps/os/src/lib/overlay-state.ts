/**
 * The provisional overlay reducer — pure, framework-free.
 *
 * Folds durable stream events into per-run assistant overlays that render
 * while a turn is streaming, until the durable transcript row lands and wins.
 * The reducer is transport-neutral; the Cap'n Web hook (`use-capn-chat.ts`) is
 * its consumer.
 */

import type { RuntimeStreamEvent } from "@tedix/api-contract/schemas/runtime-submissions";
import {
	type ChatRuntimePhase,
	isChatRuntimePhase,
} from "@tedix/chat-transport/runtime-frames";

/**
 * The runtime's turn-progress label for one run: which phase it is in, an
 * optional detail (tool or delegated tedi name), and when that phase began
 * (for the elapsed-seconds readout). Only the newest phase is kept.
 */
export type StreamedPhase = {
	phase: ChatRuntimePhase;
	detail: string | null;
	/** Epoch ms the phase started — `payload.at` when present, else `createdAt`. */
	since: number;
	sequence: number;
};

type OverlayRunState = {
	runId: string;
	/** Highest `metadata.streamAttempt` seen; redrives reset the chunk map. */
	attempt: number;
	/** sequence -> delta chunk (chunked, NOT cumulative, on the kernel path). */
	chunks: Map<number, string>;
	finalized: boolean;
	/** Full canonical text from `message.completed` — always wins over chunks. */
	finalText: string | null;
	/** Durable message id the overlay swaps against (from the finalize event). */
	messageId: string | null;
	/** Newest `message.phase` for the run; null once it finalizes. */
	phase: StreamedPhase | null;
	/**
	 * sequence -> provisional rationale chunk (`message.reasoning`). The
	 * planner's reasoning as it streams — shown as a thinking line while the
	 * turn is in flight and dropped the moment the run finalizes. It is NEVER
	 * the answer and never merges into `chunks`.
	 */
	rationaleChunks: Map<number, string>;
};

export type OverlayState = Map<string, OverlayRunState>;

export function createOverlayState(): OverlayState {
	return new Map();
}

export type StreamedOverlay = {
	runId: string;
	/** Provisional overlay key — exactly `{runId}:assistant`. */
	key: string;
	/** Durable transcript id that replaces this overlay when it lands. */
	messageId: string;
	text: string;
	/** Current runtime phase while the turn is in flight; null once finalized. */
	phase: StreamedPhase | null;
	/**
	 * Provisional planner rationale while the turn is in flight; `""` once the
	 * run finalizes. Display only — the settled answer supersedes it.
	 */
	rationale: string;
	finalized: boolean;
};

function newRunState(runId: string, attempt = 0): OverlayRunState {
	return {
		runId,
		attempt,
		chunks: new Map(),
		finalized: false,
		finalText: null,
		messageId: null,
		phase: null,
		rationaleChunks: new Map(),
	};
}

function payloadRecord(event: RuntimeStreamEvent): Record<string, unknown> {
	const payload = event.payload;
	return payload !== null &&
		payload !== undefined &&
		typeof payload === "object"
		? (payload as Record<string, unknown>)
		: {};
}

/**
 * Reads a field the server may stamp either at the envelope top level or in
 * `payload`. `RuntimeStreamEventSchema` is a strict object — the Cap'n machine
 * `safeParse`s every frame through it, so unknown top-level keys are STRIPPED
 * before the reducer sees them. `payload` is therefore the only field that
 * survives the wire for phase/channel data; the top-level read is kept for a
 * future schema that carries them natively.
 */
function eventField(event: RuntimeStreamEvent, name: string): unknown {
	const top = (event as unknown as Record<string, unknown>)[name];
	return top !== undefined ? top : payloadRecord(event)[name];
}

export function readStreamedPhase(
	event: RuntimeStreamEvent,
): StreamedPhase | null {
	if (event.kind !== "message.phase") return null;
	const phase = eventField(event, "phase");
	if (!isChatRuntimePhase(phase)) return null;
	const detail = eventField(event, "detail");
	const at = eventField(event, "at");
	const since =
		typeof at === "string" && Number.isFinite(Date.parse(at))
			? Date.parse(at)
			: Date.parse(event.createdAt);
	return {
		phase,
		detail: typeof detail === "string" && detail.trim() ? detail.trim() : null,
		since: Number.isFinite(since) ? since : Date.now(),
		sequence: typeof event.sequence === "number" ? event.sequence : 0,
	};
}

function deltaStreamAttempt(event: RuntimeStreamEvent): number {
	const metadata = event.payload?.metadata;
	if (
		metadata !== null &&
		typeof metadata === "object" &&
		!Array.isArray(metadata)
	) {
		const attempt = (metadata as Record<string, unknown>).streamAttempt;
		if (
			typeof attempt === "number" &&
			Number.isInteger(attempt) &&
			attempt >= 0
		) {
			return attempt;
		}
	}
	return 0;
}

/**
 * Does this finalization belong to a row the rendered transcript DROPS?
 *
 * `apps/api/src/rpc/routers/kernel/home-narration.ts` stamps
 * `payload.metadata.homeNarration` on every assistant turn whose prose merely
 * restates the delegation receipt (the dispatch ack "On it — delegating to
 * {tedi} now…", the operator-cancel marker, a status-only terminal
 * restatement). `readMessages` → `collapseHomeDelegationNarration` then DROPS
 * those rows from the transcript, or keeps them with `content: ""`. Either way
 * the durable bubble never carries the prose.
 *
 * The overlay's swap rule is "render until the durable row lands"
 * ({@link visibleOverlays}), keyed on the row's id appearing in the
 * transcript. For a dropped row that id never appears, so the overlay is
 * immortal — and because overlays render BELOW every durable message, the ack
 * stayed pinned to the bottom of the thread while the delegated result landed
 * above it minutes later (DOM order [user] → [delegated result] → [ack],
 * causally inverted). Dropping the overlay here is the
 * ordering fix at its source: the client stops rendering exactly what the
 * server's read path already decided not to render, so a live thread and the
 * same thread after a reload agree.
 *
 * `realtime-projections.ts` defers to the read on the SAME marker for the
 * transcript-cache patch; this is that rule applied to the streaming lane.
 */
function isHomeNarrationEvent(event: RuntimeStreamEvent): boolean {
	const metadata = event.payload?.metadata;
	if (
		metadata === null ||
		typeof metadata !== "object" ||
		Array.isArray(metadata)
	) {
		return false;
	}
	return (metadata as Record<string, unknown>).homeNarration !== undefined;
}

function joinChunks(chunks: ReadonlyMap<number, string>): string {
	return [...chunks.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([, chunk]) => chunk)
		.join("");
}

function reassembledText(run: OverlayRunState): string {
	if (run.finalText !== null) return run.finalText;
	return joinChunks(run.chunks);
}

/**
 * Applies one stream event to the overlay state. Idempotent: re-delivered
 * deltas overwrite their sequence slot, re-delivered finalizations re-assert
 * the same terminal state. Returns whether the state changed (the caller
 * only schedules a flush on change).
 *
 * Rules (from the kernel event map):
 * - `message.delta`: append-only chunks keyed by `sequence` per `runId`;
 *   a higher `metadata.streamAttempt` (redriven turn) resets the chunks —
 *   the highest attempt wins. Concatenation is a PREFIX of the final text.
 * - `message.completed`: the durable finalization — carries the FULL answer
 *   in `payload.content`; the overlay flips to it and records the event's
 *   `messageId` (handles the convergence `:plan-convergence:assistant` case).
 *   No delta for a run ever arrives after its `message.completed`.
 * - `message.completed` stamped `payload.metadata.homeNarration`: the durable
 *   row exists in the ledger but the READ never renders its prose, so the
 *   overlay has nothing to swap to — drop it (see {@link isHomeNarrationEvent}).
 * - `run.failed` / `run.canceled`: nothing durable to swap to — drop the
 *   overlay; the transcript refresh shows whatever the kernel persisted.
 * - `message.reasoning`: append-only PROVISIONAL rationale chunks keyed by
 *   `sequence` per `runId` — the planner's reasoning as it streams, on every
 *   route (this is the only thing on screen while a delegation or approval
 *   plan is decided). Kept strictly apart from the answer chunks and dropped
 *   when the run finalizes; it never becomes transcript text.
 * - `message.phase` (`payload.phase` ∈ `CHAT_RUNTIME_PHASES`, optional
 *   `payload.detail` / `payload.at`): the newest phase per run, shown as the
 *   progress row until the run finalizes.
 * Text deltas arrive on every route (delegations too), so nothing here assumes
 * answer-in-Home.
 */
export function applyOverlayEvent(
	state: OverlayState,
	event: RuntimeStreamEvent,
): boolean {
	const runId = event.runId;
	if (typeof runId !== "string" || runId === "") return false;
	switch (event.kind) {
		case "message.phase": {
			const phase = readStreamedPhase(event);
			if (phase === null) return false;
			const existing = state.get(runId);
			if (existing?.finalized) return false;
			const run = existing ?? newRunState(runId);
			if (existing === undefined) state.set(runId, run);
			// Newest phase wins; a re-delivered or stale frame changes nothing.
			if (run.phase !== null && run.phase.sequence > phase.sequence) {
				return false;
			}
			if (
				run.phase !== null &&
				run.phase.sequence === phase.sequence &&
				run.phase.phase === phase.phase &&
				run.phase.detail === phase.detail
			) {
				return false;
			}
			run.phase = phase;
			return true;
		}
		case "message.reasoning": {
			const delta = typeof event.delta === "string" ? event.delta : null;
			if (delta === null || delta === "") return false;
			const sequence = typeof event.sequence === "number" ? event.sequence : 0;
			const existing = state.get(runId);
			if (existing?.finalized) return false;
			const run = existing ?? newRunState(runId);
			if (existing === undefined) state.set(runId, run);
			if (run.rationaleChunks.get(sequence) === delta) return false;
			run.rationaleChunks.set(sequence, delta);
			return true;
		}
		case "message.delta": {
			const delta = typeof event.delta === "string" ? event.delta : null;
			if (delta === null) return false;
			const sequence = typeof event.sequence === "number" ? event.sequence : 0;
			const attempt = deltaStreamAttempt(event);
			const existing = state.get(runId);
			if (existing?.finalized) return false;
			const run: OverlayRunState = existing ?? newRunState(runId, attempt);
			if (existing === undefined) state.set(runId, run);
			if (attempt < run.attempt) return false;
			if (attempt > run.attempt) {
				run.attempt = attempt;
				run.chunks.clear();
			}
			if (run.chunks.get(sequence) === delta) return false;
			run.chunks.set(sequence, delta);
			return true;
		}
		case "message.completed": {
			const payload = event.payload;
			const role =
				payload !== null &&
				payload !== undefined &&
				typeof payload.role === "string"
					? payload.role
					: null;
			if (role !== null && role !== "assistant") return false;
			// The rendered transcript drops/blanks this row, so there is nothing to
			// swap to and an overlay kept here would pin below every later durable
			// message. Never CREATES an entry — a run that streamed nothing stays
			// absent.
			if (isHomeNarrationEvent(event)) return state.delete(runId);
			const existing = state.get(runId);
			const run: OverlayRunState = existing ?? newRunState(runId);
			if (existing === undefined) state.set(runId, run);
			const content =
				payload !== null &&
				payload !== undefined &&
				typeof payload.content === "string"
					? payload.content
					: null;
			const finalText = content ?? reassembledText(run);
			const messageId = event.messageId ?? run.messageId;
			if (
				run.finalized &&
				run.finalText === finalText &&
				run.messageId === messageId
			) {
				return false;
			}
			run.finalized = true;
			run.finalText = finalText;
			run.messageId = messageId;
			run.phase = null;
			run.rationaleChunks.clear();
			return true;
		}
		case "run.completed": {
			const run = state.get(runId);
			if (!run || run.finalized) return false;
			run.finalized = true;
			run.finalText = reassembledText(run);
			run.phase = null;
			run.rationaleChunks.clear();
			return true;
		}
		case "run.failed":
		case "run.canceled":
			return state.delete(runId);
		default:
			return false;
	}
}

/**
 * Renderable overlays: one per run with streamed text or an
 * in-flight phase, keyed `{runId}:assistant`. A run that only ever reported a
 * phase disappears the moment it finalizes — there is nothing left to show.
 */
export function listOverlays(state: OverlayState): StreamedOverlay[] {
	const overlays: StreamedOverlay[] = [];
	for (const run of state.values()) {
		const text = reassembledText(run);
		const phase = run.finalized ? null : run.phase;
		const rationale = run.finalized ? "" : joinChunks(run.rationaleChunks);
		if (text === "" && phase === null && rationale === "") continue;
		overlays.push({
			runId: run.runId,
			key: `${run.runId}:assistant`,
			messageId: run.messageId ?? `${run.runId}:assistant`,
			text,
			phase,
			rationale,
			finalized: run.finalized,
		});
	}
	return overlays;
}

/**
 * The swap-on-durable rule: an overlay renders only until the durable
 * transcript contains its assistant row — then the durable bubble wins.
 */
export function visibleOverlays(
	overlays: readonly StreamedOverlay[],
	durableMessageIds: ReadonlySet<string>,
	durableRunIds: ReadonlySet<string> = new Set(),
): StreamedOverlay[] {
	return overlays.filter(
		(overlay) =>
			!durableRunIds.has(overlay.runId) &&
			!durableMessageIds.has(overlay.messageId) &&
			!durableMessageIds.has(overlay.key),
	);
}
