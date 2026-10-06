import {
	KernelPricingEvidenceSchema,
	type KernelPricingEvidence,
} from "@tedix/api-contract/schemas/cost-provenance";
/** Durable kernel turn state; canonical runs and delivery events live in D1. */
export interface KernelActiveTurn {
	runId: string;
	conversationId: string;
	stage: string;
	phase?: string;
	detail?: string;
	answer?: string;
	at: string;
}

export const MAX_ACTIVE_TURN_STAGE_LENGTH = 80;
export const MAX_ACTIVE_TURN_DETAIL_LENGTH = 200;
export const MAX_ACTIVE_TURN_ANSWER_LENGTH = 4000;

export function boundKernelActiveTurn(
	turn: KernelActiveTurn,
): KernelActiveTurn {
	const detail =
		turn.detail !== undefined
			? turn.detail.slice(0, MAX_ACTIVE_TURN_DETAIL_LENGTH)
			: undefined;
	return {
		runId: turn.runId,
		conversationId: turn.conversationId,
		stage: turn.stage.slice(0, MAX_ACTIVE_TURN_STAGE_LENGTH),
		...(turn.phase !== undefined
			? { phase: turn.phase.slice(0, MAX_ACTIVE_TURN_STAGE_LENGTH) }
			: {}),
		...(detail !== undefined ? { detail } : {}),
		...(turn.answer !== undefined
			? { answer: turn.answer.slice(0, MAX_ACTIVE_TURN_ANSWER_LENGTH) }
			: {}),
		at: turn.at,
	};
}

interface KernelRunUsage {
	pricing: KernelPricingEvidence | null;
	inputTokens: number | null;
	outputTokens: number | null;
	reasoningTokens: number | null;
	totalTokens: number | null;
	costUsd: number | null;
}

export interface KernelState {
	organizationId: string | null;
	activeTurn: KernelActiveTurn | null;
	approvalMirrors?: Record<string, unknown>;
}
export const INITIAL_KERNEL_STATE: KernelState = {
	organizationId: null,
	activeTurn: null,
};

function finiteNumberOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Extract a compact usage projection from a `kernel_runtime_runs.metadata`
 * JSON blob. Returns `undefined` (field omitted) when no meaningful usage is
 * present — fail-soft against missing, null, or non-numeric fields.
 *
 * Source: `metadata.bodyExecutionResult.usage` (written by the kernel turn
 * body's {@link buildBodyExecutionResult} call) and
 * `metadata.bodyExecutionResult.cost.totalCostUsd`.
 * `totalTokens` is derived as `inputTokens + outputTokens`; null if either is
 * absent (mirrors the usage invariant: null = unavailable, never fabricated 0).
 */
export function extractRunUsage(
	metadata: Record<string, unknown> | null | undefined,
): KernelRunUsage | undefined {
	const bodyResult = metadata?.bodyExecutionResult;
	if (
		typeof bodyResult !== "object" ||
		bodyResult === null ||
		Array.isArray(bodyResult)
	) {
		return undefined;
	}
	const body = bodyResult as Record<string, unknown>;
	const usageRaw = body.usage;
	const costRaw = body.cost;

	const inputTokens = finiteNumberOrNull(
		typeof usageRaw === "object" && usageRaw !== null
			? (usageRaw as Record<string, unknown>).inputTokens
			: undefined,
	);
	const outputTokens = finiteNumberOrNull(
		typeof usageRaw === "object" && usageRaw !== null
			? (usageRaw as Record<string, unknown>).outputTokens
			: undefined,
	);
	const reasoningTokens = finiteNumberOrNull(
		typeof usageRaw === "object" && usageRaw !== null
			? (usageRaw as Record<string, unknown>).reasoningTokens
			: undefined,
	);
	const totalTokens =
		inputTokens !== null && outputTokens !== null
			? inputTokens + outputTokens
			: null;
	const costUsd = finiteNumberOrNull(
		typeof costRaw === "object" && costRaw !== null
			? (costRaw as Record<string, unknown>).totalCostUsd
			: undefined,
	);

	// Omit entirely when there is nothing meaningful to report.
	if (
		inputTokens === null &&
		outputTokens === null &&
		reasoningTokens === null &&
		totalTokens === null &&
		costUsd === null
	) {
		return undefined;
	}
	const parsedPricing = KernelPricingEvidenceSchema.safeParse(
		typeof costRaw === "object" && costRaw !== null
			? (costRaw as Record<string, unknown>).pricing
			: null,
	);
	const pricing = parsedPricing.success ? parsedPricing.data : null;
	return {
		inputTokens,
		outputTokens,
		reasoningTokens,
		totalTokens,
		costUsd:
			pricing && pricing.costCompleteness !== "complete" ? null : costUsd,
		pricing,
	};
}
