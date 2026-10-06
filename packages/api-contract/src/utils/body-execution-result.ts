import {
	type BodyExecutionResult,
	BodyExecutionResultSchema,
	type BodyExecutionUsage,
} from "../schemas/body-certification";

export type BodyExecutionResultError = NonNullable<
	BodyExecutionResult["error"]
>;
export type BodyExecutionResultUsage = BodyExecutionResult["usage"];
export type BodyExecutionResultCost = BodyExecutionResult["cost"];
export type BodyExecutionResultSession = BodyExecutionResult["session"];
export type BodyExecutionResultWorkstation = BodyExecutionResult["workstation"];

export function bodyExecutionDurationMs(input: {
	endedAt?: string | null;
	startedAt?: string | null;
}): number | null {
	if (!input.startedAt || !input.endedAt) return null;
	const started = Date.parse(input.startedAt);
	const ended = Date.parse(input.endedAt);
	if (!Number.isFinite(started) || !Number.isFinite(ended)) return null;
	return Math.max(0, ended - started);
}

export function defaultBodyExecutionUsage(
	usage?: Partial<BodyExecutionResultUsage>,
): BodyExecutionResultUsage {
	return {
		provider: usage?.provider ?? null,
		model: usage?.model ?? null,
		inputTokens: usage?.inputTokens ?? null,
		outputTokens: usage?.outputTokens ?? null,
		reasoningTokens: usage?.reasoningTokens ?? null,
		cacheReadTokens: usage?.cacheReadTokens ?? null,
		cacheWriteTokens: usage?.cacheWriteTokens ?? null,
	};
}

function usageNumberOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function usageStringOrNull(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Project an arbitrary record (e.g. a runtime-event `payload.usage` blob, or an
 * AI-SDK usage object) onto the canonical {@link BodyExecutionResultUsage}
 * shape, applying the null-absent invariant: a field the source omits becomes
 * `null` (never a fabricated `0`). Returns `null` when the input is not a record
 * or carries NO usable usage field — so an empty/foreign blob never masquerades
 * as reported usage. The single reader/writer projector that keeps the canonical
 * runtime-event `usage` field in sync with whatever a body buried in its payload.
 */
export function bodyExecutionUsageFromRecord(
	value: unknown,
): BodyExecutionUsage | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	const usage: BodyExecutionUsage = {
		provider: usageStringOrNull(record.provider),
		model: usageStringOrNull(record.model),
		inputTokens: usageNumberOrNull(record.inputTokens),
		outputTokens: usageNumberOrNull(record.outputTokens),
		reasoningTokens: usageNumberOrNull(record.reasoningTokens),
		cacheReadTokens: usageNumberOrNull(record.cacheReadTokens),
		cacheWriteTokens: usageNumberOrNull(record.cacheWriteTokens),
	};
	const anyPresent = Object.values(usage).some((field) => field !== null);
	return anyPresent ? usage : null;
}

export function defaultBodyExecutionCost(
	cost?: Partial<BodyExecutionResultCost>,
): BodyExecutionResultCost {
	return {
		pricing: cost?.pricing ?? null,
		billingType: cost?.billingType ?? "unknown",
		biller: cost?.biller ?? null,
		modelCostUsd: cost?.modelCostUsd ?? null,
		toolCostUsd: cost?.toolCostUsd ?? null,
		totalCostUsd: cost?.totalCostUsd ?? null,
	};
}

export function defaultBodyExecutionSession(
	session?: Partial<BodyExecutionResultSession>,
): BodyExecutionResultSession {
	return {
		beforeRef: session?.beforeRef ?? null,
		afterRef: session?.afterRef ?? null,
		adapterSessionRef: session?.adapterSessionRef ?? null,
		clearSession: session?.clearSession ?? false,
	};
}

export function buildBodyExecutionResult(input: {
	id?: string;
	bodyKind: string;
	status: BodyExecutionResult["status"];
	runId: string;
	tediId?: string | null;
	orgId?: string | null;
	conversationId?: string | null;
	sessionKey?: string | null;
	harnessVersionId?: string | null;
	traceBundleId?: string | null;
	workstation?: BodyExecutionResultWorkstation | null;
	startedAt: string;
	endedAt?: string | null;
	durationMs?: number | null;
	summary?: string | null;
	structuredResult?: Record<string, unknown> | null;
	error?: BodyExecutionResultError | null;
	usage?: Partial<BodyExecutionResultUsage>;
	cost?: Partial<BodyExecutionResultCost>;
	session?: Partial<BodyExecutionResultSession>;
	approvalIds?: string[];
	artifactIds?: string[];
	runtimeServices?: string[];
}): BodyExecutionResult {
	const traceBundleId = input.traceBundleId ?? null;
	const endedAt = input.endedAt ?? null;
	return BodyExecutionResultSchema.parse({
		id: input.id ?? `${traceBundleId ?? input.runId}:body-execution-result`,
		bodyKind: input.bodyKind,
		status: input.status,
		runId: input.runId,
		tediId: input.tediId ?? null,
		orgId: input.orgId ?? null,
		conversationId: input.conversationId ?? null,
		sessionKey: input.sessionKey ?? null,
		harnessVersionId: input.harnessVersionId ?? null,
		traceBundleId,
		workstation: input.workstation ?? null,
		startedAt: input.startedAt,
		endedAt,
		durationMs:
			input.durationMs ??
			bodyExecutionDurationMs({ startedAt: input.startedAt, endedAt }),
		summary: input.summary ?? null,
		structuredResult: input.structuredResult ?? null,
		error: input.error ?? null,
		usage: defaultBodyExecutionUsage(input.usage),
		cost: defaultBodyExecutionCost(input.cost),
		session: defaultBodyExecutionSession(input.session),
		approvalIds: input.approvalIds ?? [],
		artifactIds: input.artifactIds ?? [],
		runtimeServices: input.runtimeServices ?? [],
	});
}
