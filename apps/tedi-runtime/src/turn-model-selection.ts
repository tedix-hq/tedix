/**
 * Per-turn model selection + the final-step stop rule.
 *
 * ONE place where every turn host in this Worker resolves WHICH model runs a
 * turn, so the provider dance (Azure via the BYOK gateway or Workers
 * AI selected by a catalog-validated
 * per-role override on top) can never be re-derived differently in two places.
 * Consumers: the parent `AgentTediDO` (`do.ts`), the conversation facet, the
 * synthesis facet, and the blind-evidence judge facet.
 *
 * It also owns the final-step stop rule, because "how the turn is allowed to
 * end" is the other half of per-turn execution policy: {@link
 * FINAL_STEP_STOP_RULE} is the token stamped onto the harness loop-policy
 * descriptor and {@link finalStepToolChoice} is the live guard that enforces
 * it, so the stamp can never drift from the behaviour.
 *
 * Native Pi owns the turn loop. This module selects the governed model and
 * final-step policy; provider dispatch owns usage accounting.
 */

import type { ModelRequestTelemetry } from "./model-request-telemetry";
import type { ProviderBeforeDispatch } from "@tedix/workers-ai/gateway-transport";
import {
	findCatalogEntry,
	type AdaptiveRoutingContext,
	type ModelOverride,
} from "@tedix/api-contract/schemas/model-catalog";
import {
	DEFAULT_WORKERS_AI_MODEL,
	CLOUDFLARE_AUTO_MODEL_REF,
	cloudflareAutoRouterEligible,
	cloudflareAutoRouterModel,
	selectWorkersAiModel,
} from "@tedix/workers-ai/model-select";
import { azureModel, selectAzureDeployment } from "./ai-sdk-adapter";
import { type AigMetadata, aigMetadataRecord, type AzureChatEnv } from "./llm";
import {
	type WorkersAiEnv,
	workersAiClient,
	workersAiRuntimeModel,
} from "./workers-ai-client";

/**
 * Token for the final-step stop rule the turn loop applies (`toolChoice:
 * "none"` on the last permitted step). Named so the stamped harness loop-policy
 * descriptor and the live guard read the SAME rule — the stamp can never
 * silently drift from the behaviour.
 */
export const FINAL_STEP_STOP_RULE = "toolChoice:none";

/** Select the configured model; errors never change provider authority. */
export function selectChatModelForTurn(
	env: AzureChatEnv,
	modelOverride?: ModelOverride | { modelRef?: unknown } | null,
	metadata?: AigMetadata,
	onRequest?: (request: ModelRequestTelemetry) => void,
	adaptiveRouting?: AdaptiveRoutingContext | null,
	beforeDispatch?: ProviderBeforeDispatch,
) {
	const deployment = selectAzureDeployment(env, modelOverride);
	const overrideRef =
		modelOverride && typeof modelOverride === "object"
			? (modelOverride as { modelRef?: unknown }).modelRef
			: undefined;
	// Only an explicit governed Workers AI selection chooses that provider.
	const useWorkersAI =
		typeof overrideRef === "string" && overrideRef.startsWith("workers-ai/");
	if (
		overrideRef === CLOUDFLARE_AUTO_MODEL_REF &&
		!cloudflareAutoRouterEligible(overrideRef, adaptiveRouting)
	)
		throw new Error(
			"Auto Router violates explicit fixed-model or residency policy",
		);
	const useAuto = cloudflareAutoRouterEligible(
		typeof overrideRef === "string" ? overrideRef : null,
		adaptiveRouting,
	);
	// Per-role model id from the turn override; falls back to the env default.
	const workersAiId = selectWorkersAiModel(
		env.TEDI_WORKERS_AI_MODEL || DEFAULT_WORKERS_AI_MODEL,
		typeof overrideRef === "string" ? overrideRef : null,
	);
	const model = useAuto
		? cloudflareAutoRouterModel(
				workersAiClient(env as unknown as WorkersAiEnv, beforeDispatch),
				{
					gatewayId: env.AI_GATEWAY_LLM_ID?.trim() ?? "",
					...(metadata
						? { attribution: aigMetadataRecord(metadata) ?? undefined }
						: {}),
					...(metadata?.sessionKeyHash
						? { sessionId: metadata.sessionKeyHash }
						: {}),
				},
			)
		: useWorkersAI
			? workersAiRuntimeModel(
					env as unknown as WorkersAiEnv,
					workersAiId,
					metadata,
					beforeDispatch,
				)
			: azureModel(env, metadata, onRequest, beforeDispatch).responses(
					deployment,
				);
	const identity = useAuto
		? ({
				provider: "workers-ai",
				model: CLOUDFLARE_AUTO_MODEL_REF,
			} as const)
		: useWorkersAI
			? ({ provider: "workers-ai", model: workersAiId } as const)
			: ({ provider: "azure-openai", model: deployment } as const);
	return { model, identity };
}

/**
 * Resolve the blind evidence judge's model. A configured
 * `TEDI_JUDGE_MODEL_REF` pins BOTH provider and model and intentionally ignores
 * ordinary adaptive routing: switching to a differently calibrated
 * verifier is a correctness change, not an availability fallback. Invalid or
 * unavailable pins fail closed. With no pin, the judge falls back to the shared
 * chat selection above.
 */
export function selectJudgeModelForTurn(
	env: AzureChatEnv,
	metadata?: AigMetadata,
	beforeDispatch?: ProviderBeforeDispatch,
) {
	const pinnedRef = env.TEDI_JUDGE_MODEL_REF?.trim();
	if (!pinnedRef || pinnedRef === CLOUDFLARE_AUTO_MODEL_REF)
		return selectChatModelForTurn(
			env,
			{ modelRef: CLOUDFLARE_AUTO_MODEL_REF },
			metadata,
			undefined,
			undefined,
			beforeDispatch,
		);
	const pinned = findCatalogEntry(pinnedRef);
	if (!pinned) {
		throw new Error(`Invalid TEDI_JUDGE_MODEL_REF: ${pinnedRef}`);
	}
	if (pinned.provider === "azure-openai") {
		return {
			model: azureModel(env, metadata, undefined, beforeDispatch).responses(
				pinned.modelId,
			),
			identity: {
				provider: "azure-openai" as const,
				model: pinned.modelId,
			},
		};
	}
	if (pinned.provider === "workers-ai") {
		if (!(env as unknown as WorkersAiEnv).AI) {
			throw new Error(
				`TEDI_JUDGE_MODEL_REF provider is unavailable: ${pinnedRef}`,
			);
		}
		return {
			model: workersAiRuntimeModel(
				env as unknown as WorkersAiEnv,
				pinned.modelId,
				metadata,
				beforeDispatch,
			),
			identity: {
				provider: "workers-ai" as const,
				model: pinned.modelId,
			},
		};
	}
	throw new Error(`TEDI_JUDGE_MODEL_REF provider is unavailable: ${pinnedRef}`);
}

/**
 * Concrete form of {@link FINAL_STEP_STOP_RULE}: on the LAST permitted step
 * (`stepNumber >= maxSteps - 1`) force `toolChoice: "none"` so the turn always
 * ends with a synthesized TEXT answer instead of a dangling tool-only stop —
 * which otherwise surfaces as `empty_assistant_message` / `run.failed`. Called
 * by native Pi provider preparation before dispatch.
 */
export function finalStepToolChoice(
	stepNumber: number,
	maxSteps: number,
): { toolChoice: "none" } | undefined {
	return stepNumber >= maxSteps - 1 ? { toolChoice: "none" } : undefined;
}
