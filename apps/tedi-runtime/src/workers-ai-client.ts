import { requestInferenceOriginGuard } from "./runtime-inference-origin";
/**
 * This Worker's Workers AI client: the two app-owned seams bound to the shared
 * `@tedix/workers-ai` transport.
 *
 * The package owns the wire (gateway-vs-binding, request shape, tool-call
 * recovery, the `LanguageModelV2` adapter) and deliberately owns NEITHER of the
 * things that differ per app:
 *
 *   - AUTHORIZATION — every paid inference from the Agent runtime must first
 *     reserve the organization's entitlement through `API_SERVICE`
 *     (`authorizeInferenceEntitlement`), which also folds the reservation id
 *     into the packed gateway attribution. A denial throws a
 *     `BillingAdmissionError` BEFORE the request leaves the Worker.
 *   - ATTRIBUTION — `cf-aig-metadata` is encoded by this app's
 *     `aigMetadataRecord` (`llm.ts`), which emits ONLY the fields present and
 *     `null` when none are, and throws above the 5-entry AI Gateway cap. The
 *     kernel's encoder differs; that difference is pinned by
 *     `aig-metadata-golden.test.ts` and must not be flattened into the package.
 *     The transport only SERIALIZES the record it is handed.
 *
 * Provider CHOICE (Azure vs Workers AI) is not here either — that is
 * `turn-model-selection.ts`.
 */

import { workersAiModel } from "@tedix/workers-ai/model";
import type {
	WorkersAiClient,
	WorkersAiTransportEnv,
} from "@tedix/workers-ai/transport";
import type { LanguageModel } from "ai";
import type { ProviderBeforeDispatch } from "@tedix/workers-ai/gateway-transport";
import {
	authorizeInferenceEntitlement,
	type BillingReservationEnv,
} from "./billing-reservation-client";
import { type AigMetadata, aigMetadataRecord } from "./llm";

/**
 * Env surface a Workers AI call needs here: the shared transport's vars plus
 * the billing binding the authorize seam reserves against.
 */
export type WorkersAiRuntimeEnv = WorkersAiTransportEnv & BillingReservationEnv;

/**
 * {@link WorkersAiRuntimeEnv} with the `AI` binding required. Either transport
 * path suffices at runtime, but the binding is always bound in this Worker (it
 * also backs `env.AI.toMarkdown`), and the provider-choice sites gate on its
 * presence.
 */
export interface WorkersAiEnv extends WorkersAiRuntimeEnv {
	AI: Ai;
}

/**
 * Bind this Worker's authorize seam to the shared transport. `input.attribution`
 * arrives as the already-normalized record this app produced, so it maps back to
 * {@link AigMetadata} one-to-one: `aigMetadataRecord` only ever preserves that
 * interface's own string fields.
 */
export function workersAiClient(
	env: WorkersAiRuntimeEnv,
	beforeDispatch?: ProviderBeforeDispatch,
): WorkersAiClient {
	return {
		env,
		authorize: async (input) => {
			const requestGuard = requestInferenceOriginGuard(beforeDispatch);
			const reserved = await authorizeInferenceEntitlement(env, {
				metadata: input.attribution as AigMetadata | undefined,
				execution: input.execution,
				body: input.body,
				beforeDispatch: requestGuard,
				signal: input.signal,
			});
			return {
				attribution: aigMetadataRecord(reserved.attribution) ?? undefined,
				beforeDispatch: reserved.beforeDispatch,
			};
		},
	};
}

/**
 * Build a Workers AI `LanguageModelV2` for this Worker: the shared adapter with
 * both seams already bound. Model selection is the caller's job
 * (`selectWorkersAiModel` in `@tedix/workers-ai/model-select`).
 */
export function workersAiRuntimeModel(
	env: WorkersAiEnv,
	modelId: string,
	metadata?: AigMetadata,
	beforeDispatch?: ProviderBeforeDispatch,
): LanguageModel {
	return workersAiModel(
		workersAiClient(env, beforeDispatch),
		modelId,
		aigMetadataRecord(metadata) ?? undefined,
	);
}
