import type { RecordVoiceProviderUsageInput } from "@tedix/api-contract/schemas/billing";
import type { DbClient } from "@tedix/db/client";
import { recordBillingProviderUsage } from "@tedix/db/queries/billing/provider-usage";
import { estimateProviderUnitCostMicros } from "@tedix/db/utils/provider-pricing";

/**
 * Persist one idempotent, directly observed voice provider unit.
 *
 * This deliberately does not create a customer charge. Voice has provider-
 * specific units and remains reconciliation evidence until a priced customer
 * product explicitly opts into metering it.
 */
export async function recordVoiceProviderUsage(
	db: DbClient,
	input: RecordVoiceProviderUsageInput,
) {
	const estimate = estimateProviderUnitCostMicros(input);
	const row = await recordBillingProviderUsage(db, {
		id: crypto.randomUUID(),
		organizationId: input.organizationId,
		tediId: input.tediId,
		providerUsageId: input.providerUsageId,
		gatewayLogId: input.gatewayLogId,
		provider: input.provider,
		model: input.model,
		usageKind: input.usageKind,
		unit: input.unit,
		quantity: input.quantity,
		providerCostMicros: estimate.providerCostMicros,
		providerCostQuality: "estimated",
		occurredAt: input.occurredAt,
		metadata: {
			...input.metadata,
			recordingPath: "direct_voice_runtime",
			rateCardVersion: estimate.rateCardVersion,
			pricingStatus: estimate.rateCardVersion ? "estimated" : "unpriced",
		},
		now: new Date().toISOString(),
	});
	const rateCardVersion =
		typeof row.metadata.rateCardVersion === "string"
			? row.metadata.rateCardVersion
			: null;
	return {
		usageId: row.id,
		providerCostMicros: row.providerCostMicros,
		providerCostQuality: "estimated" as const,
		rateCardVersion,
	};
}
