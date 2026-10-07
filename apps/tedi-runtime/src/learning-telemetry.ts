import type { BridgeMetrics } from "./brain/bridge";
import { projectEmbeddedTranscript } from "./embedded-transcript";

/** Measure authored text, not the widget's injected page/host context. */
export function learningUserTextLength(
	content: string,
	isEmbedded: boolean,
): number | null {
	if (!isEmbedded) return content.length;
	const projected = projectEmbeddedTranscript({
		messages: [{ role: "user", content }],
	});
	return projected.messages[0]?.content.length ?? null;
}

export type LearningSkipReason =
	| "ephemeral_session"
	| "blind_verification"
	| "lean_context_session"
	| "learning_disabled"
	| "no_platform_client"
	| "no_model_gateway";

interface LearningAttribution {
	runId: string;
	traceId?: string;
	sessionKey?: string;
	origin?: string;
	userChars: number | null;
	assistantChars: number;
}

interface ObserverMetrics {
	status: "not_started" | "completed" | "failed";
	durationMs: number | null;
	observations: number | null;
	configuredModel: string | null;
	inputChars: number | null;
}

interface ReflectorMetrics {
	/** Invoked does not imply successful condensation: reflect() is fail-soft. */
	status:
		| "not_started"
		| "below_threshold"
		| "no_client"
		| "invoked"
		| "failed";
	durationMs: number | null;
	inputTokens: number | null;
	outputObservations: number | null;
}

/**
 * Post-observer stages. `bridge` is the essential fact write; the rest are
 * optional projections that each run under their own budget, so one slow stage
 * records `timed_out` without failing the whole learning pass.
 */
export type LearningStageName =
	| "bridge"
	| "rationale"
	| "crystallizer"
	| "task_promotion"
	| "artifact"
	| "trace_bundle";

export interface LearningStageMetrics {
	status: "completed" | "failed" | "timed_out" | "skipped";
	durationMs: number;
	/** The wall-clock budget the stage was given (its cap or what remained). */
	budgetMs: number;
}

export interface LearningTelemetryEvent extends LearningAttribution {
	event: "tedi.learning";
	status: "completed" | "failed" | "skipped";
	skipReason: LearningSkipReason | null;
	elapsedMs: number;
	observer: ObserverMetrics;
	reflector: ReflectorMetrics;
	/** Successful canonical writes, NOT projection success or useful recall. */
	bridge: BridgeMetrics | null;
	/** Per-stage timing after the observer; absent stages never started. */
	stages: Partial<Record<LearningStageName, LearningStageMetrics>>;
}

/** One content-free event per bridge attempt; null means a stage did not report. */
export function createLearningTelemetry(
	input: LearningAttribution,
	options: {
		now?: () => number;
		emit?: (event: LearningTelemetryEvent) => void;
	} = {},
) {
	const now = options.now ?? (() => performance.now());
	const emit = options.emit ?? ((event) => console.log(event));
	const started = now();
	let finished = false;
	const tracker = {
		observer: {
			status: "not_started",
			durationMs: null,
			observations: null,
			configuredModel: null,
			inputChars: null,
		} as ObserverMetrics,
		reflector: {
			status: "not_started",
			durationMs: null,
			inputTokens: null,
			outputObservations: null,
		} as ReflectorMetrics,
		bridge: null as BridgeMetrics | null,
		stages: {} as Partial<Record<LearningStageName, LearningStageMetrics>>,
		finish(
			status: LearningTelemetryEvent["status"],
			skipReason: LearningSkipReason | null = null,
		): void {
			if (finished) return;
			finished = true;
			emit({
				event: "tedi.learning",
				runId: input.runId,
				traceId: input.traceId,
				sessionKey: input.sessionKey,
				origin: input.origin,
				userChars: input.userChars,
				assistantChars: input.assistantChars,
				status,
				skipReason,
				elapsedMs: Math.max(0, Math.round(now() - started)),
				observer: { ...tracker.observer },
				reflector: { ...tracker.reflector },
				bridge: tracker.bridge ? { ...tracker.bridge } : null,
				stages: Object.fromEntries(
					Object.entries(tracker.stages).map(([name, stage]) => [
						name,
						{ ...stage },
					]),
				),
			});
		},
	};
	return tracker;
}

export type LearningTelemetry = ReturnType<typeof createLearningTelemetry>;

/** Shared attribution for queued bridges and turns skipped before queuing. */
export function createTurnLearningTelemetry(payload: {
	runId: string;
	traceId?: string;
	sessionKey?: string;
	origin?: string;
	user: { content: string; sessionKey?: string };
	assistant: { content: string };
}) {
	const sessionKey = payload.sessionKey ?? payload.user.sessionKey;
	return createLearningTelemetry({
		runId: payload.runId,
		traceId: payload.traceId,
		sessionKey,
		origin: payload.origin,
		userChars: learningUserTextLength(
			payload.user.content,
			sessionKey?.startsWith("embed:") ?? false,
		),
		assistantChars: payload.assistant.content.length,
	});
}
