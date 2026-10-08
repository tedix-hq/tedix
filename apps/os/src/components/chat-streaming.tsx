import type { ChatRuntimePhase } from "@tedix/chat-transport/runtime-frames";
import { useEffect, useState } from "react";
import { ChatMarkdown } from "@/components/chat-markdown";
import { Loader } from "@/components/kumo/loader";
import type { StreamedPhase } from "@/lib/overlay-state";
import { sanitizeUntrustedText } from "@/lib/untrusted-text";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// StreamedAssistantBubble — the provisional overlay bubble
// ---------------------------------------------------------------------------

/**
 * Provisional assistant entry for in-flight streamed text. Visually matches
 * the durable assistant treatment (no bubble — plain text on the canvas,
 * left-aligned) with one subtle streaming affordance: a pulsing caret after
 * the text while the run is still producing. `done` (the finalize event
 * arrived, durable row not yet rendered) drops the caret so the swap is
 * seamless.
 *
 * The text goes through the SAME `ChatMarkdown` the durable row uses
 * (`ChatMessageBubble`). Rendering the in-flight text raw meant every streamed
 * turn showed its fences, `**` markers, and list bullets and then visibly
 * reflowed into formatted prose the moment the durable row landed — a layout
 * jump on every assistant turn. A partial document is legitimate markdown
 * input: an unterminated fence renders as an open code block that fills in as
 * the stream continues, which is the intended mid-stream shape, not a defect.
 */
export function StreamedAssistantBubble({
	text,
	done = false,
}: {
	text: string;
	done?: boolean;
}) {
	return (
		<li
			data-role="assistant"
			data-slot="streaming-bubble"
			data-streaming={done ? "false" : "true"}
			aria-busy={!done}
			className="flex w-full justify-start"
		>
			<div className={cn("flex min-w-0 max-w-full flex-col gap-1 py-0.5")}>
				{/*
				 * The caret has to sit on the last line of the rendered markdown, not
				 * on a line of its own beneath it. `ChatMarkdown` is a block wrapper
				 * around block children, so two layout-only overrides put the caret
				 * back in the last line's inline flow: `display: contents` dissolves
				 * the markdown wrapper (its own styling — colour, whitespace, wrapping
				 * — is all inherited, so nothing is lost), and the trailing paragraph
				 * goes inline so the caret follows it. A block last child (a mid-stream
				 * code fence, a list) keeps its own box and the caret drops below it,
				 * which is the correct reading for those shapes.
				 */}
				<div className="min-w-0 [&>.chat-markdown]:contents [&_.chat-markdown>p:last-of-type]:inline">
					<ChatMarkdown content={text} />
					{done ? null : (
						/*
						 * The caret is functional feedback (a turn is still being
						 * written), so it may animate — but on the OS motion contract,
						 * not Tailwind's stock 2s `pulse` cycle. It runs on the
						 * `tedix-structural` duration and the standard easing, and
						 * `motion-reduce` drops it to a solid bar rather than removing
						 * the affordance. See `docs/engineering/product/design.md`, "Elevation,
						 * Borders, and Motion".
						 */
						<span
							aria-hidden
							data-slot="streaming-caret"
							className="ml-0.5 inline-block h-3.5 w-0.5 animate-pulse rounded-full bg-kumo-brand align-text-bottom [animation-duration:var(--duration-tedix-structural)] [animation-timing-function:var(--ease-tedix-standard)] motion-reduce:animate-none"
						/>
					)}
				</div>
			</div>
		</li>
	);
}

// ---------------------------------------------------------------------------
// StreamedRationaleRow — the planner's provisional thinking line
// ---------------------------------------------------------------------------

/**
 * The route planner's `rationale` as it streams — the decision forming, shown
 * while the turn is in flight.
 *
 * It exists because the planner only ever forwarded `answer` deltas, and
 * `answer` is null on every route except `answer_in_home`: a delegation, a
 * write proposal, a workflow start or a clarifying question showed the
 * operator NOTHING until the rendered acknowledgement replayed at the end of
 * the pass.
 *
 * PROVISIONAL and display-only. Deliberately NOT the assistant treatment:
 * muted, italic, one line, no markdown and no caret, so it can never be
 * mistaken for the answer. Sanitized as untrusted runtime text, and PRE-SPACED
 * — the row keeps exactly one line of height whether or not any rationale has
 * arrived, so the thread does not shift when the first chunk lands or when the
 * settled answer supersedes it.
 */
export function StreamedRationaleRow({ rationale }: { rationale: string }) {
	const text = sanitizeUntrustedText(rationale).trim();
	return (
		<li
			className="flex w-full justify-start"
			data-slot="streaming-rationale"
			data-empty={text === "" ? "true" : "false"}
			aria-live="polite"
		>
			<div className="min-h-5 min-w-0 max-w-full truncate py-0.5 text-kumo-subtle italic type-tedix-body">
				{text}
			</div>
		</li>
	);
}

// ---------------------------------------------------------------------------
// StreamedPhaseRow — the runtime's turn-progress label
// ---------------------------------------------------------------------------

/** Renderer-owned labels for the cross-surface `ChatRuntimePhase` vocabulary. */
export const CHAT_PHASE_LABELS: Record<ChatRuntimePhase, string> = {
	preparing_context: "Preparing context",
	planning: "Planning",
	generating: "Writing",
	using_tool: "Using a tool",
	delegating: "Delegating",
	finalizing: "Finalizing",
};

/**
 * "Preparing context · 7s". The detail (a tool or tedi name) is untrusted
 * runtime text and is sanitized; the elapsed readout is whole seconds since the
 * phase began so the label reads as progress rather than a stopwatch.
 */
export function phaseRowLabel(phase: StreamedPhase, now: number): string {
	const base = CHAT_PHASE_LABELS[phase.phase];
	const detail = phase.detail ? sanitizeUntrustedText(phase.detail).trim() : "";
	const elapsed = Math.max(0, Math.floor((now - phase.since) / 1000));
	return `${detail ? `${base}: ${detail}` : base} · ${elapsed}s`;
}

function useElapsedTick(active: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		setNow(Date.now());
		const handle = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(handle);
	}, [active]);
	return now;
}

/**
 * Sits where `RunningIndicator` sits (same loader, same live region) and
 * replaces its generic "Working on it…" once the runtime says what it is
 * doing. One row per run; the reducer keeps only the newest phase.
 */
export function StreamedPhaseRow({
	phase,
	now,
}: {
	phase: StreamedPhase;
	/** Injectable clock for tests; defaults to a 1s ticker. */
	now?: number;
}) {
	const tick = useElapsedTick(now === undefined);
	return (
		<li
			className="flex w-full justify-start"
			data-slot="streaming-phase"
			data-phase={phase.phase}
			aria-live="polite"
		>
			<div className="flex items-center gap-2 py-1 text-kumo-subtle type-tedix-body">
				<span aria-hidden="true" className="flex items-center">
					<Loader aria-label="Working" size={16} />
				</span>
				<span className="tabular-nums">
					{phaseRowLabel(phase, now ?? tick)}
				</span>
			</div>
		</li>
	);
}
