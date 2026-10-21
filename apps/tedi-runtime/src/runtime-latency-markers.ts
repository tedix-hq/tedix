/**
 * Content-free `_tr` latency markers for the runtime's hot path.
 *
 * They exist because one end-to-end `executeFacetTool` span cannot be
 * attributed: one end-to-end number cannot separate the
 * tool's own work from the resolve/RPC/queue cost of the facet → parent hop, or
 * from the ledger writes that used to sit inside the same span. Each marker
 * reports durations measured WITHIN one component; the facet emits its own
 * caller-side half (`facet_tool_wait`) for the same `(runId, toolCallId)`.
 * Join on those ids — never subtract the two components' raw timestamps.
 *
 * Payloads carry ids, names and durations only. No prompt text, tool arguments
 * or results: these lines land in Workers Logs, which is not trace-safety
 * scoped.
 *
 * Every emitter is best-effort and swallows its own errors — a marker must
 * never break the turn it is measuring.
 */

function emit(project: () => Record<string, unknown>): void {
	try {
		console.log(JSON.stringify(project()));
	} catch {
		/* marker is best-effort */
	}
}

/** Callee-side half of the facet → parent tool hop. */
export function markFacetToolDispatch(input: {
	tediId: string | null;
	runId: string;
	toolCallId: string;
	tool: string;
	/** Wall time spent inside `executeFacetTool`. */
	calleeMs: number;
	/** Delegation-authority evaluation + verdict publication. */
	authorityMs: number;
	/** The proxied tool's own execution. */
	executeMs: number;
	finishReason: string;
}): void {
	emit(() => ({
		_tr: "facet_tool_dispatch",
		tediId: input.tediId,
		runId: input.runId,
		toolCallId: input.toolCallId,
		tool: input.tool,
		calleeMs: input.calleeMs,
		authorityMs: input.authorityMs,
		executeMs: input.executeMs,
		finishReason: input.finishReason,
	}));
}

/** One line per recorded model step (`step.completed`). */
export function markStepCompleted(input: {
	tediId: string;
	runId: string;
	stepNumber: number;
	finishReason: string | null;
	/** Provider-round elapsed time; null when no measurement is available. */
	durationMs: number | null;
	inputTokens: number | null;
	outputTokens: number | null;
}): void {
	emit(() => ({
		_tr: "step",
		tediId: input.tediId,
		runId: input.runId,
		stepNumber: input.stepNumber,
		finishReason: input.finishReason,
		durationMs: input.durationMs,
		inputTokens: input.inputTokens,
		outputTokens: input.outputTokens,
	}));
}

/**
 * Mandatory spend authorization, awaited inside the fetch wrapper before EVERY
 * provider request (`ai-sdk-adapter.ts`, `llm.ts`, `@tedix/workers-ai`,
 * `do.ts`).
 *
 * This leg was invisible to every other measurement: AI Gateway starts its
 * clock when the request arrives, and the facet markers stop before it, yet
 * it can account for most of a multi-round answer's time.
 *
 * `parseMs` is separated because the estimator parses the whole request body
 * (thousands of tokens of JSON) on every round before the RPC even starts, so a
 * slow authorization and a slow estimate need different fixes. Content-free:
 * identifiers, token COUNTS and durations only, never the body.
 */
export function markInferenceAuthorize(input: {
	runId: string | null;
	provider: string;
	model: string;
	source: string | null;
	/** Request-body parse + token estimate. */
	parseMs: number;
	/** The `runtimeEntitlements/authorizeInference` service-binding RPC. */
	rpcMs: number;
	totalMs: number;
	estimatedInputTokens: number | null;
	outcome: "authorized" | "denied" | "error";
}): void {
	emit(() => ({
		_tr: "inference_authorize",
		runId: input.runId,
		provider: input.provider,
		model: input.model,
		source: input.source,
		parseMs: input.parseMs,
		rpcMs: input.rpcMs,
		totalMs: input.totalMs,
		estimatedInputTokens: input.estimatedInputTokens,
		outcome: input.outcome,
	}));
}

/** Caller-side half of the facet -> parent tool hop. */
export function markFacetToolWait(input: {
	runId: string | null;
	toolCallId: string;
	tool: string;
	/** Total time the facet waited on `executeFacetTool`. */
	waitMs: number;
	/** Dynamic import + `parentAgent` resolution inside that wait. */
	resolveMs: number;
}): void {
	emit(() => ({
		_tr: "facet_tool_wait",
		runId: input.runId,
		toolCallId: input.toolCallId,
		tool: input.tool,
		waitMs: input.waitMs,
		resolveMs: input.resolveMs,
	}));
}

/** The leg AFTER each model round: usage accounting, then ledger telemetry. */
export function markStepFinish(input: {
	runId: string | null;
	accountingMs: number;
	telemetryMs: number;
	totalMs: number;
}): void {
	emit(() => ({
		_tr: "facet_step_finish",
		runId: input.runId,
		accountingMs: input.accountingMs,
		telemetryMs: input.telemetryMs,
		totalMs: input.totalMs,
	}));
}

/**
 * The leg BEFORE each model round, opposite `facet_step_finish`.
 *
 * Native provider preparation reconciles pending effects and takes a durable step
 * reservation, and every one of those is a facet -> parent round trip. Without
 * this marker that time sits in neither the model, the tool, nor any named
 * span. Content-free.
 */
export function markStepPrepare(input: {
	runId: string | null;
	/** Replaying computer effects the previous step left pending. */
	reconcileMs: number;
	/** Durable admission for this step (cancellation check + reservation). */
	reserveMs: number;
	totalMs: number;
}): void {
	emit(() => ({
		_tr: "facet_step_prepare",
		runId: input.runId,
		reconcileMs: input.reconcileMs,
		reserveMs: input.reserveMs,
		totalMs: input.totalMs,
	}));
}

/** One line per tool call entering the parent's AI-SDK tool wrapper. */
export function markToolCall(input: {
	tediId: string | null;
	runId: string | null;
	toolName: string;
	toolCallId: string;
	stepNumber: number | null;
	turnPrincipalId: string | null;
	turnSurface: string | null;
}): void {
	emit(() => ({
		_tr: "tool.call",
		tediId: input.tediId,
		runId: input.runId,
		toolName: input.toolName,
		toolCallId: input.toolCallId,
		stepNumber: input.stepNumber,
		turnPrincipalId: input.turnPrincipalId,
		turnSurface: input.turnSurface,
	}));
}
