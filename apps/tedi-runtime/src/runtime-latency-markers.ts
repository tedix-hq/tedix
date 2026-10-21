/**
 * Content-free `_tr` latency markers for the runtime's hot path.
 *
 * They exist because one end-to-end `executeFacetTool` span cannot be
 * attributed: one end-to-end number cannot separate the
 * tool's own work from the resolve/RPC/queue cost of the facet → parent hop, or
 * from the ledger writes that used to sit inside the same span. Each marker
 * reports durations measured within one component.
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
