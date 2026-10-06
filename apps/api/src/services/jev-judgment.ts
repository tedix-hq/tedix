import { providerDeploymentScope } from "@tedix/api-contract/schemas/provider-execution";
import type { NewTediCallCost } from "@tedix/db/schema/tedis";
import type { DbClient } from "@tedix/db/client";
import { insertCallCosts } from "@tedix/db/queries/tedi-usage";
import { callJev, JevResponseError } from "@tedix/workers-ai/jev";
import { resolveProviderModelRate } from "./provider-model-pricing";
import {
	computeCostMicros,
	type ProviderTokenRates,
} from "@tedix/db/utils/model-pricing";
import { reserveKernelBilling } from "../rpc/routers/kernel/billing-reservation";
import {
	kernelGatewayMetadata,
	type KernelGatewayContext,
	type KernelExecutionAttempt,
} from "../rpc/routers/kernel/gateway-attribution";
import type { JevEnv } from "@tedix/workers-ai/jev";
import type { DecisionModel } from "@tedix/api-contract/schemas/jev";
import type { KernelWorkersAiEnv } from "../rpc/routers/kernel/workers-ai-client";

import type { JevQuestion, JevRequest, JevResult } from "@tedix/workers-ai/jev";
/** Paid usage could not reach D1. The caller must retain its execution evidence. */
export class JevUsagePersistenceError extends Error {
	constructor(readonly executionId: string) {
		super(`Jev usage persistence failed for execution ${executionId}`);
		this.name = "JevUsagePersistenceError";
	}
}

export interface JevJudgmentInput<
	Q extends Record<string, JevQuestion>,
> extends JevRequest<Q> {
	db: DbClient;
	env: KernelWorkersAiEnv & JevEnv;
	context: KernelGatewayContext;
	source: string;
	billingSource: "kernel" | "system";
	sessionType: NonNullable<NewTediCallCost["sessionType"]>;
	/** Explicit per-purpose promotion target; omitted keeps the adopted Jev default. */
	model?: DecisionModel;
	transport?: "cloudflare" | "direct";
	onExecutionAttempts?: (attempts: readonly KernelExecutionAttempt[]) => void;
}

/** One admitted dispatch; receipt retries never replay inference or switch providers.
 * Adopted semantic judgments use this by default. Ranking's experimental policy is caller-owned.
 */
export async function executeJevJudgment<Q extends Record<string, JevQuestion>>(
	input: JevJudgmentInput<Q>,
): Promise<JevResult<Q> | null> {
	const {
		db,
		env,
		context,
		state,
		questions,
		source,
		billingSource,
		sessionType,
		model,
		transport = env.JEV_TRANSPORT ?? "cloudflare",
		timeoutMs = 2000,
		signal,
		onExecutionAttempts,
	} = input;
	if (!context.organizationId || signal?.aborted) return null;
	let admitted: KernelGatewayContext | undefined;
	let admittedRate: (ProviderTokenRates & { id: string }) | undefined;
	const attempts: KernelExecutionAttempt[] = [];
	const billingContext = {
		...context,
		source,
		executionAttempts: attempts,
	};
	const client = {
		env: { ...env, JEV_TRANSPORT: transport },
		authorize: async ({
			execution,
			body,
		}: Parameters<Parameters<typeof callJev>[0]["authorize"]>[0]) => {
			const rate = await resolveProviderModelRate(env, {
				provider: execution.provider,
				modelId: execution.requestModel,
				deploymentScope: providerDeploymentScope(execution),
				occurredAt: new Date().toISOString(),
			});
			if (rate.status !== "resolved")
				throw new Error("Jev judgment requires a governed provider rate");
			admittedRate = rate.rate;
			admitted = await reserveKernelBilling(env, {
				context: billingContext,
				source: billingSource,
				execution,
				body,
				tokenEstimates: {
					// A byte is a conservative token bound; /3 undercounts multilingual state.
					input:
						typeof body === "string"
							? Math.max(1, new TextEncoder().encode(body).byteLength)
							: 30000,
					// Bound copied legends plus answer probabilities and envelope for any primitive.
					output: Object.values(questions).reduce(
						(sum, question) =>
							sum +
							new TextEncoder().encode(JSON.stringify(question)).byteLength +
							1024,
						128,
					),
				},
			});
			context.executionAttempts?.push(...attempts);
			onExecutionAttempts?.(attempts);
			return { attribution: kernelGatewayMetadata(admitted) };
		},
	};
	async function recordUsage(
		usage: {
			input_tokens: number;
			output_tokens: number;
		},
		resolvedModel?: string,
		callDurationMs?: number,
	) {
		const attempt = attempts.at(-1);
		if (!attempt || !admitted?.executionId)
			throw new Error("Missing Jev execution admission");
		const tokens = {
			inputTokens: usage.input_tokens,
			outputTokens: usage.output_tokens,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		};
		attempt.usage = tokens;
		if (!admittedRate) throw new Error("Missing admitted Jev rate");
		const micros = computeCostMicros(admittedRate, tokens);
		const priced = {
			costUsd: micros === null ? null : Number(micros) / 1_000_000,
			rateVersionId: admittedRate.id,
			reason: micros === null ? "invalid_usage" : null,
		};
		// Durable provider evidence lets the existing billing-metering job retry settlement.
		// Jev Gateway logs contain metadata only; ingestion excludes them because
		// this provider-response receipt is the canonical usage/cost row.
		const row: NewTediCallCost = {
			id: crypto.randomUUID(),
			orgId: context.organizationId!,
			tediId: context.tediId ?? null,
			gatewayLogId: `jev-execution:${admitted.executionId}`,
			gatewayId: attempt.identity.gatewayId ?? "direct:typesafe",
			snapshotAt: attempt.occurredAt,
			model: resolvedModel ?? attempt.identity.requestModel,
			provider: attempt.identity.provider,
			providerResource: null,
			providerBaseUrl: attempt.identity.providerOrigin,
			deployment: null,
			runId: context.runId ?? null,
			workItemId: context.workItemId ?? null,
			billingReservationId: admitted.billingReservationId ?? null,
			sessionType: sessionType,
			source: `provider-response:${source}`,
			inputTokens: usage.input_tokens,
			outputTokens: usage.output_tokens,
			totalTokens: usage.input_tokens + usage.output_tokens,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			estimatedCostUsd: priced.costUsd,
			executionId: admitted.executionId,
			callDurationMs: callDurationMs ?? null,
			rateVersionId: priced.rateVersionId,
			costBasis: priced.costUsd === null ? "unknown" : "governed_estimate",
			costReason: priced.reason,
			// Provider produced paid usage, even when its answer fails semantic validation.
			success: true,
			cached: false,
			sessionCount: 1,
			dataQuality: priced.costUsd === null ? "quarantined_no_pricing" : "ok",
		};
		// Retry the same immutable receipt, never the paid inference. The unique
		// execution-derived key makes a committed-but-response-lost insert safe.
		for (let retry = 0; retry < 3; retry++) {
			try {
				await insertCallCosts(db, [row]);
				return;
			} catch {
				if (retry < 2)
					await new Promise((resolve) =>
						setTimeout(resolve, retry === 0 ? 100 : 250),
					);
			}
		}
		// A total D1 outage has no durable recovery guarantee here. Keep usage on
		// the published attempt and emit only reconciliation fields, never content.
		console.error(
			"[jev-judgment] paid usage not persisted; reconciliation required",
			{
				executionId: admitted.executionId,
				organizationId: context.organizationId,
				reservationId: admitted.billingReservationId ?? null,
				provider: attempt.identity.provider,
				requestModel: attempt.identity.requestModel,
				resolvedModel: resolvedModel ?? null,
				occurredAt: attempt.occurredAt,
				inputTokens: usage.input_tokens,
				outputTokens: usage.output_tokens,
				rateVersionId: admittedRate.id,
				costMicros: micros === null ? null : Number(micros),
			},
		);
		throw new JevUsagePersistenceError(admitted.executionId);
	}

	const callStartedAt = performance.now();
	let callDurationMs: number | undefined;
	try {
		const result = await callJev(client, {
			model,
			state,
			questions,
			signal,
			timeoutMs,
		});
		callDurationMs = Math.max(0, performance.now() - callStartedAt);
		await recordUsage(result.usage, result.model, callDurationMs);
		return result;
	} catch (error) {
		if (error instanceof JevUsagePersistenceError) throw error;
		if (error instanceof JevResponseError && error.usage) {
			callDurationMs ??= Math.max(0, performance.now() - callStartedAt);
			await recordUsage(error.usage, undefined, callDurationMs);
		}
		console.warn("[jev-judgment] judgment unavailable", {
			executionId: admitted?.executionId ?? null,
			failure:
				error instanceof JevResponseError
					? "provider_response"
					: "dispatch_or_admission",
			status: error instanceof JevResponseError ? (error.status ?? null) : null,
		});
		return null;
	}
}
