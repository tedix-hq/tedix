import type { RuntimeFrame } from "./runtime-frames";

type Stage =
	| "authorized"
	| "response"
	| "firstFrame"
	| "firstText"
	| "terminal"
	| "terminalSent"
	| "terminalAcknowledged"
	| "drained";
export interface EmbeddedStreamTiming {
	runId: string;
	resume: boolean;
	outcome: "completed" | "failed";
	durationMs: number;
	stages: Partial<Record<Stage, number>>;
	frames: number;
	acknowledged: number;
	maxPending: number;
	maxAcknowledgmentMs: number;
}

/** Fixed-size, content-free measurements; never retain a frame or its payload. */
export function createEmbeddedStreamTiming(now: () => number = Date.now) {
	const started = now();
	const stages: EmbeddedStreamTiming["stages"] = {};
	let frames = 0,
		acknowledged = 0,
		pending = 0,
		maxPending = 0,
		maxAcknowledgmentMs = 0;
	const elapsed = () => Math.max(0, now() - started);
	const mark = (stage: Stage) => {
		stages[stage] ??= elapsed();
	};
	const terminal = (frame: RuntimeFrame) =>
		frame.event.kind === "done" || frame.event.kind === "error";
	return {
		mark,
		receive(frame: RuntimeFrame) {
			frames++;
			mark("firstFrame");
			if (
				frame.event.kind === "delta" &&
				typeof frame.event.text === "string" &&
				frame.event.text.length
			)
				mark("firstText");
			if (terminal(frame)) mark("terminal");
		},
		async deliver(frame: RuntimeFrame, send: () => Promise<void>) {
			const sent = now();
			maxPending = Math.max(maxPending, ++pending);
			if (terminal(frame)) mark("terminalSent");
			try {
				await send();
				acknowledged++;
				if (terminal(frame)) mark("terminalAcknowledged");
			} finally {
				pending--;
				maxAcknowledgmentMs = Math.max(
					maxAcknowledgmentMs,
					Math.max(0, now() - sent),
				);
			}
		},
		snapshot(
			runId: string,
			resume: boolean,
			outcome: EmbeddedStreamTiming["outcome"],
		): EmbeddedStreamTiming {
			return {
				runId,
				resume,
				outcome,
				durationMs: elapsed(),
				stages: { ...stages },
				frames,
				acknowledged,
				maxPending,
				maxAcknowledgmentMs,
			};
		},
	};
}
