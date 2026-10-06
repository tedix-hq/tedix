/**
 * Pure shaping of native Pi provider receipts into step.completed telemetry.
 * ConversationFacet supplies provider usage and elapsed time; the parent
 * records the JSON-safe receipt in the runtime ledger.
 */

import type { ModelRequestTelemetry } from "./model-request-telemetry";
import type { resolveFacetGeneration } from "./facet-generation-settings";
import type { BodyExecutionUsage } from "@tedix/api-contract/schemas/body-certification";
import {
	cloudflareAutoRouterReceipt,
	type CloudflareAutoRouterReceipt,
} from "@tedix/workers-ai/model-select";

/**
 * JSON-safe per-step telemetry payload. Validates against the platform ledger's
 * `RuntimeMetadataSchema` (`z.record(z.string(), z.unknown())`).
 *
 * `usage` carries top-level `inputTokens` /
 * `outputTokens` / `totalTokens`, plus `inputTokenDetails.cacheReadTokens` /
 * `cacheWriteTokens` for prompt-cache accounting and
 * `outputTokenDetails.reasoningTokens`. Provider-omitted numerics normalize to
 * `null` so the payload is clean and stable in the ledger.
 */
export type StepTelemetryPayload = {
	generation?: {
		requested: ReturnType<typeof resolveFacetGeneration>["requested"];
		resolved: ReturnType<typeof resolveFacetGeneration>["resolved"];
		wire: ModelRequestTelemetry;
	};
	source: "pi-provider-receipt";
	stepNumber: number;
	finishReason: string;
	provider?: string | null;
	model?: string | null;
	/** Cloudflare's actual adaptive-routing choice, when this was an Auto turn. */
	autoRouter?: CloudflareAutoRouterReceipt;
	toolCallCount: number;
	toolResultCount: number;
	toolNames: string[];
	textLength: number;
	/**
	 * Wall time this step took, measured between step boundaries: the model
	 * round plus any tools it ran. Null when the caller had no clock — never
	 * invented. This is the only per-step latency signal the runtime has, and
	 * without it "the assistant feels slow" cannot be answered with a number.
	 */
	durationMs: number | null;
	usage: {
		inputTokens: number | null;
		outputTokens: number | null;
		totalTokens: number | null;
		reasoningTokens: number | null;
		cacheReadTokens: number | null;
		cacheWriteTokens: number | null;
	};
};

export interface BufferedFacetToolStep {
	finishReason: string;
	toolNames: string[];
	toolResultCount?: number;
}

/**
 * Project the facet proxy buffer into the compact terminal tool-call summary
 * carried by ChatTurnWorkflow and the cron execution ledger.
 *
 * A ConversationFacet call is represented by one synthetic step. The parent
 * records the step before dispatch and then changes its finish reason/result
 * count at the completion boundary. That makes an incomplete, unavailable, or
 * thrown call mechanically unsuccessful without inspecting model prose.
 */
export function facetToolCallOutcomes(
	steps: readonly BufferedFacetToolStep[],
): Array<{ name: string; ok: boolean }> {
	const outcomes: Array<{ name: string; ok: boolean }> = [];
	for (const step of steps) {
		const failed =
			step.finishReason === "facet-tool-error" ||
			step.finishReason === "facet-tool-unavailable" ||
			(step.toolResultCount ?? 0) < 1;
		for (const name of step.toolNames) {
			if (typeof name === "string" && name.length > 0) {
				outcomes.push({ name, ok: !failed });
			}
		}
	}
	return outcomes;
}

function numOrNull(value: number | undefined | null): number | null {
	return typeof value === "number" ? value : null;
}

/**
 * Local structural view of the native Pi receipt projection this shaper reads.
 */
interface StepTelemetryInput {
	model?: { provider?: string; modelId?: string };
	providerMetadata?: unknown;
	usage?: {
		inputTokens?: number | null;
		outputTokens?: number | null;
		totalTokens?: number | null;
		inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
		outputTokenDetails?: { reasoningTokens?: number };
	};
	stepNumber?: number;
	finishReason?: string;
	toolCalls?: Array<{ toolName: string }>;
	toolResults?: unknown[];
	text?: string;
}

/**
 * Extract a JSON-safe {@link StepTelemetryPayload} from a native Pi provider receipt
 * projected into the runtime step shape. Pure + side-effect-free.
 *
 * Provider-omitted usage fields remain `null`, including when the receipt has
 * no usage at all, so unavailable telemetry never becomes a fabricated zero.
 */
export function shapeStepTelemetry(
	ctxInput: unknown,
	durationMs?: number | null,
): StepTelemetryPayload {
	const ctx = (ctxInput ?? {}) as StepTelemetryInput;
	const usage = ctx.usage;
	const cacheRead = usage?.inputTokenDetails?.cacheReadTokens;
	const reasoning = usage?.outputTokenDetails?.reasoningTokens;
	const toolCalls = Array.isArray(ctx.toolCalls) ? ctx.toolCalls : [];
	const toolResults = Array.isArray(ctx.toolResults) ? ctx.toolResults : [];
	const autoRouter = cloudflareAutoRouterReceipt(ctx.providerMetadata);
	return {
		source: "pi-provider-receipt",
		stepNumber: typeof ctx.stepNumber === "number" ? ctx.stepNumber : 0,
		finishReason: ctx.finishReason ?? "unknown",
		provider: ctx.model?.provider ?? null,
		model: ctx.model?.modelId ?? null,
		...(autoRouter ? { autoRouter } : {}),
		toolCallCount: toolCalls.length,
		toolResultCount: toolResults.length,
		toolNames: toolCalls.map((call) => call.toolName),
		textLength: typeof ctx.text === "string" ? ctx.text.length : 0,
		durationMs:
			typeof durationMs === "number" && Number.isFinite(durationMs)
				? Math.max(0, Math.round(durationMs))
				: null,
		usage: {
			inputTokens: numOrNull(usage?.inputTokens),
			outputTokens: numOrNull(usage?.outputTokens),
			totalTokens: numOrNull(usage?.totalTokens),
			reasoningTokens: numOrNull(reasoning),
			cacheReadTokens: numOrNull(cacheRead),
			cacheWriteTokens: numOrNull(usage?.inputTokenDetails?.cacheWriteTokens),
		},
	};
}

/**
 * Aggregate per-turn token usage a {@link ConversationFacet} accumulates across
 * its native Pi provider-round receipts. The facet returns this receipt
 * for the parent's `run.completed.tokensUsed`; it also mirrors each model step
 * separately for detailed usage and identity. Same NULL-ABSENT INVARIANT as
 * {@link summarizeToolSteps} /
 * {@link bodyExecutionUsageFromSteps}: a field stays `null` until at least one
 * step reports a finite value (telemetry-unavailable ≠ a fabricated zero).
 */
export interface FacetTurnUsage {
	inputTokens: number | null;
	outputTokens: number | null;
	totalTokens: number | null;
}

/** A zeroed (all-null) {@link FacetTurnUsage} — the per-turn accumulator seed. */
export function emptyFacetTurnUsage(): FacetTurnUsage {
	return { inputTokens: null, outputTokens: null, totalTokens: null };
}

/** Per-step usage rows the trace-bundle buffer holds (a `Record` of nullable nums). */
type BufferedStepUsage = {
	provider?: string | null;
	model?: string | null;
	usage?: Record<string, number | null>;
} | null;

/**
 * Roll one run's buffered tool steps up into the turn-level navigation summary
 * — the single implementation behind BOTH the trace bundle's `scores.json` and
 * the `run.completed` ledger event's `tokensUsed` (`peekTotalTokens`), so the
 * two turn-level token counts can never drift apart.
 *
 * Same USAGE INVARIANT as {@link bodyExecutionUsageFromSteps}: `totalTokens`
 * stays `null` unless at least one step actually reported a finite
 * `totalTokens` — never a fabricated `0` (telemetry unavailable ≠ zero).
 */
export function summarizeToolSteps(
	steps: ReadonlyArray<{
		toolCallCount: number;
		usage?: Record<string, number | null> | null;
	}>,
): { steps: number; toolCalls: number; totalTokens: number | null } {
	let toolCalls = 0;
	let totalTokens: number | null = null;
	for (const step of steps) {
		toolCalls += step.toolCallCount;
		const value = step.usage?.totalTokens;
		if (typeof value === "number" && Number.isFinite(value)) {
			totalTokens = (totalTokens ?? 0) + value;
		}
	}
	return { steps: steps.length, toolCalls, totalTokens };
}

/**
 * Reduce the per-run buffered step usage into the canonical
 * {@link BodyExecutionUsage} envelope the isolate stamps onto its
 * `BodyExecutionResult` (body-parity with the kernel's `routeUsage` threading).
 *
 * USAGE INVARIANT: a token field is summed ONLY across the steps that actually
 * reported it; if NO step reported that field, it stays `null` — never a
 * fabricated `0`. So a run whose provider surfaced no usage emits all-null token
 * counts (telemetry unavailable), distinct from a genuine zero. `provider` /
 * `model` identify reported usage only when every contributing step has the same
 * known identity. Missing or mixed identities remain null; a configured default
 * or the newest model cannot identify tokens from earlier rounds.
 */
export function bodyExecutionUsageFromSteps(
	steps: ReadonlyArray<BufferedStepUsage>,
): BodyExecutionUsage {
	const TOKEN_FIELDS = [
		"inputTokens",
		"outputTokens",
		"reasoningTokens",
		"cacheReadTokens",
		"cacheWriteTokens",
	] as const;
	type TokenField = (typeof TOKEN_FIELDS)[number];
	const sums: Record<TokenField, number | null> = {
		inputTokens: null,
		outputTokens: null,
		reasoningTokens: null,
		cacheReadTokens: null,
		cacheWriteTokens: null,
	};
	let identity: { provider: string; model: string } | null = null;
	let unknownIdentity = false;
	for (const step of steps) {
		if (!step?.usage) continue;
		const usage = step.usage;
		// Synthetic tool rows carry no usage. A reported zero still contributes;
		// all-null usage does not identify any of the aggregate's token counts.
		if (
			[...TOKEN_FIELDS, "totalTokens"].some(
				(field) =>
					typeof usage[field] === "number" && Number.isFinite(usage[field]),
			)
		) {
			if (!step.provider || !step.model) {
				unknownIdentity = true;
			} else if (
				identity &&
				(identity.provider !== step.provider || identity.model !== step.model)
			) {
				unknownIdentity = true;
			} else {
				identity = { provider: step.provider, model: step.model };
			}
		}
		for (const field of TOKEN_FIELDS) {
			const value = usage[field];
			if (typeof value === "number" && Number.isFinite(value)) {
				sums[field] = (sums[field] ?? 0) + value;
			}
		}
	}
	return {
		provider: unknownIdentity ? null : (identity?.provider ?? null),
		model: unknownIdentity ? null : (identity?.model ?? null),
		inputTokens: sums.inputTokens,
		outputTokens: sums.outputTokens,
		reasoningTokens: sums.reasoningTokens,
		cacheReadTokens: sums.cacheReadTokens,
		cacheWriteTokens: sums.cacheWriteTokens,
	};
}
