/**
 * Kernel — the model seam for conversation-history compaction.
 *
 * `compactKernelHistory` folds the oldest turns of a long Home thread into one
 * checkpoint. WHAT that checkpoint says is decided here: this module builds the
 * {@link HistorySummarizer} the production turn injects, so the checkpoint is a
 * real model handoff rather than the mechanical extractive digest.
 *
 * Until this existed the seam had exactly one caller — a test — so every live
 * compaction emitted the digest. That was the whole defect.
 *
 * Shape, deliberately identical to the other secondary kernel inference sites
 * (`conversation-title.ts`, `run-store.ts`):
 * - {@link kernelModel} for the provider decision (Azure via authenticated AI
 *   Gateway, or Workers AI under the force flag / open breaker). A `null` model
 *   means NO summarizer is produced at all, so assembly behaves exactly as it
 *   did before this module existed: the extractive digest.
 * - `tracedAi.generateText` — never a bare `import { generateText } from "ai"`,
 *   which emits no GenAI spans and would make Home compaction invisible in the
 *   Agents dashboard.
 * - `kernelSpanContext()` so span attribution matches the AI Gateway metadata
 *   `kernelModel` already attaches to the same call.
 *
 * FAIL-SOFT IS LOAD-BEARING. Compaction runs INSIDE turn assembly: unlike the
 * auto-title path this is not post-settle, so a throw here would take the whole
 * operator turn down. Every failure — provider error, timeout/abort, unusable
 * output — returns `null` and lets `compactKernelHistory` fall back to the
 * extractive digest. This function never throws outward.
 */

import type { HistorySummarizer } from "./context-compaction";
import {
	type KernelGatewayContext,
	kernelSpanContext,
} from "./gateway-attribution";
import { type KernelEnv, kernelModel } from "./llm";
import { safeExceptionTopology } from "../../../lib/safe-log-metadata";

/**
 * Compact initiating purpose for the compaction call — distinct from the
 * turn's `kernel:route` so this spend is separable in AI Gateway and in the
 * span dashboard.
 */
export const HISTORY_SUMMARY_SOURCE = "kernel:history_compaction";

/** Telemetry `functionId` → `gen_ai.agent.name` for the compaction span. */
export const HISTORY_SUMMARY_FUNCTION_ID = "kernel.history_compaction";

/**
 * Bounded wall-clock budget for the summarization round trip. Tighter than the
 * auto-title's 10s would be generous — but this one sits in front of the
 * operator's reply, so it stays small: a slow provider costs a worse checkpoint,
 * never a stalled turn.
 */
export const HISTORY_SUMMARY_TIMEOUT_MS = 8_000;

/**
 * Output ceiling derived from the checkpoint's char ceiling. `maxChars` is a
 * hard clamp applied by the caller either way; this only keeps the provider
 * from generating far past it. Chars/4 is the same estimator the budget
 * arithmetic uses, plus headroom for the section scaffolding.
 */
export function historySummaryOutputTokens(maxChars: number): number {
	return Math.max(256, Math.ceil(maxChars / 4) + 128);
}

/**
 * Build the production history summarizer, or `undefined` when no model is
 * available — in which case the caller passes nothing and compaction keeps its
 * pre-existing extractive behavior exactly.
 */
export function createKernelHistorySummarizer(
	env: KernelEnv,
	context?: KernelGatewayContext,
): HistorySummarizer | undefined {
	const gatewayContext: KernelGatewayContext = {
		...context,
		source: HISTORY_SUMMARY_SOURCE,
	};
	const model = kernelModel(env, undefined, gatewayContext);
	if (!model) return undefined;

	return async ({ systemPrompt, transcript, maxChars }) => {
		const abortController = new AbortController();
		const timeoutId = setTimeout(
			() => abortController.abort(),
			HISTORY_SUMMARY_TIMEOUT_MS,
		);
		try {
			const { tracedAi } = await import("../../../lib/traced-ai");
			const result = await tracedAi.generateText({
				model: model.model,
				system: systemPrompt,
				runtimeContext: kernelSpanContext(gatewayContext),
				telemetry: { functionId: HISTORY_SUMMARY_FUNCTION_ID },
				messages: [{ role: "user", content: transcript }],
				maxOutputTokens: historySummaryOutputTokens(maxChars),
				abortSignal: abortController.signal,
			});
			const text = result.text?.trim();
			return text ? text : null;
		} catch (error) {
			// Inside turn assembly — degrade, never propagate.
			console.warn({
				component: "kernel.history_compaction",
				event: "model_summarizer_failed",
				exception: safeExceptionTopology(error),
			});
			return null;
		} finally {
			clearTimeout(timeoutId);
		}
	};
}
