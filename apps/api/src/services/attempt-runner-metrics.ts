import { LaneTelemetryInputSchema } from "@tedix/api-contract/schemas/work-agent-sessions";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { listEffectiveProviderModelRates } from "@tedix/db/queries/billing/provider-model-rates";
import type { VerifiedExternalAgent } from "../rpc/routers/work-items-principal";
import type { BaseContext } from "../rpc/orpc";
import { resolveFleetAuthorityDb } from "../lib/fleet-authority";
import { estimateLaneUsage } from "./lane-telemetry";

export async function attemptRunnerMetrics(
	context: BaseContext,
	session: VerifiedExternalAgent | null,
	metadata: Record<string, JsonValue>,
): Promise<Record<string, JsonValue>> {
	const parsed = LaneTelemetryInputSchema.safeParse(metadata.runnerTelemetry);
	const telemetry = parsed.success ? parsed.data : null;
	let estimatedCostUsd: number | null = null;
	let rateVersionIds: string[] = [];
	if (telemetry?.usage && telemetry.provider && telemetry.rateScope) {
		try {
			const rates = await listEffectiveProviderModelRates(
				resolveFleetAuthorityDb(context.env),
				{
					provider: telemetry.provider,
					deploymentScope: telemetry.rateScope,
					occurredAt: telemetry.finishedAt ?? new Date().toISOString(),
				},
			);
			const priced = estimateLaneUsage(telemetry, rates);
			estimatedCostUsd = priced.costUsd;
			rateVersionIds = priced.rateVersionIds;
		} catch {
			// Missing rate authority must not prevent settlement or invent zero spend.
		}
	}
	return {
		harness: session?.harness ?? telemetry?.executor ?? null,
		modelId: telemetry?.model ?? session?.modelId ?? null,
		modelVersion:
			!telemetry?.model || telemetry.model === session?.modelId
				? (session?.modelVersion ?? null)
				: null,
		tokensIn: telemetry?.usage?.input ?? null,
		tokensOut: telemetry?.usage?.output ?? null,
		estimatedCostUsd,
		rateVersionIds,
		changes: metadata.runnerChanges ?? null,
	};
}
