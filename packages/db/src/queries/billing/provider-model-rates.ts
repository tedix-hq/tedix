/** Immutable provider-rate publication and event-time lookup. */
import { and, asc, eq, gt, lte, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import {
	providerModelRateVersions,
	type NewProviderModelRateVersionRow,
} from "../../schema/provider-model-rates";
import { getAffectedRows } from "../../utils/d1-result";
import {
	computeCostMicros,
	type ProviderTokenUsage,
} from "../../utils/model-pricing";

export interface PublishProviderModelRateParams extends NewProviderModelRateVersionRow {}

/** One conditional insert is the publication fence; no read-then-write race. */
export async function publishProviderModelRate(
	db: DbQueryClient,
	input: PublishProviderModelRateParams,
) {
	if (!input.deploymentScope.trim()) return null;
	const from = new Date(input.effectiveFrom).toISOString();
	const published = new Date(input.publishedAt).toISOString();
	const verified = new Date(input.verifiedAt).toISOString();
	const prior = input.supersedesRateVersionId ?? null;
	const tokenMin = input.inputTokenMin ?? 0;
	const tokenMax = input.inputTokenMax ?? null;
	if (
		!Number.isSafeInteger(tokenMin) ||
		tokenMin < 0 ||
		(tokenMax !== null &&
			(!Number.isSafeInteger(tokenMax) || tokenMax <= tokenMin))
	)
		return null;
	const result = await db.run(sql`INSERT INTO provider_model_rate_versions (
  id, provider, model_id, deployment_scope, input_token_min, input_token_max, effective_from,
  input_microusd_per_million, output_microusd_per_million, cache_read_microusd_per_million, cache_write_microusd_per_million,
  currency, evidence_uri, evidence_digest, verified_at, published_at, published_by, change_reason, supersedes_rate_version_id
 ) SELECT ${input.id}, ${input.provider}, ${input.modelId}, ${input.deploymentScope}, ${tokenMin}, ${tokenMax}, ${from},
 ${input.inputMicrousdPerMillion}, ${input.outputMicrousdPerMillion}, ${input.cacheReadMicrousdPerMillion}, ${input.cacheWriteMicrousdPerMillion},
 ${input.currency}, ${input.evidenceUri}, ${input.evidenceDigest}, ${verified}, ${published}, ${input.publishedBy}, ${input.changeReason}, ${prior}
 WHERE ${verified} <= ${published}
 AND NOT EXISTS (
   SELECT 1 FROM provider_model_rate_versions AS existing
   WHERE existing.provider = ${input.provider} AND existing.model_id = ${input.modelId} AND existing.deployment_scope = ${input.deploymentScope}
    AND (existing.id IS NOT ${prior})
    AND (existing.input_token_max IS NULL OR existing.input_token_max > ${tokenMin})
    AND (${tokenMax} IS NULL OR existing.input_token_min < ${tokenMax})
    AND NOT EXISTS (SELECT 1 FROM provider_model_rate_versions AS correction WHERE correction.supersedes_rate_version_id = existing.id AND correction.effective_from <= ${from})
  ) AND (
  (${prior} IS NULL AND ${from} > ${published}) OR (${prior} IS NOT NULL AND EXISTS (
   SELECT 1 FROM provider_model_rate_versions AS original
   WHERE original.id = ${prior} AND original.provider = ${input.provider} AND original.model_id = ${input.modelId}
    AND original.deployment_scope = ${input.deploymentScope} AND original.input_token_min = ${tokenMin}
    AND (original.input_token_max IS ${tokenMax})
    AND (original.effective_from = ${from}
      OR (${from} > ${published} AND ${from} > original.effective_from))
    AND NOT EXISTS (SELECT 1 FROM provider_model_rate_versions AS correction WHERE correction.supersedes_rate_version_id = original.id)
  ))
 )`);
	if (getAffectedRows(result) === 0) return null;
	const [row] = await db
		.select()
		.from(providerModelRateVersions)
		.where(eq(providerModelRateVersions.id, input.id))
		.limit(1);
	return row ?? null;
}

export async function listProviderModelRates(
	db: DbQueryClient,
	input: {
		provider?: string;
		modelId?: string;
		afterId?: string;
		limit?: number;
	} = {},
) {
	return db
		.select()
		.from(providerModelRateVersions)
		.where(
			and(
				input.provider === undefined
					? undefined
					: eq(providerModelRateVersions.provider, input.provider),
				input.modelId === undefined
					? undefined
					: eq(providerModelRateVersions.modelId, input.modelId),
				input.afterId === undefined
					? undefined
					: gt(providerModelRateVersions.id, input.afterId),
			),
		)
		.orderBy(asc(providerModelRateVersions.id))
		.limit(Math.min(100, Math.max(1, input.limit ?? 50)));
}

/** At most two candidates are enough to prove ambiguous resolution. */
export async function findProviderModelRates(
	db: DbQueryClient,
	input: {
		provider: string;
		modelId: string;
		deploymentScope: string;
		occurredAt: string;
		inputTokens?: number;
	},
) {
	if (!input.deploymentScope.trim()) return [];
	const inputTokens = input.inputTokens ?? 0;
	if (!Number.isSafeInteger(inputTokens) || inputTokens < 0) return [];
	const occurredAt = new Date(input.occurredAt).toISOString();
	return db
		.select()
		.from(providerModelRateVersions)
		.where(
			and(
				eq(providerModelRateVersions.provider, input.provider),
				eq(providerModelRateVersions.modelId, input.modelId),
				eq(providerModelRateVersions.deploymentScope, input.deploymentScope),
				lte(providerModelRateVersions.inputTokenMin, inputTokens),
				sql`(${providerModelRateVersions.inputTokenMax} IS NULL OR ${providerModelRateVersions.inputTokenMax} > ${inputTokens})`,
				lte(providerModelRateVersions.effectiveFrom, occurredAt),
				sql`NOT EXISTS (SELECT 1 FROM provider_model_rate_versions AS correction WHERE correction.supersedes_rate_version_id = ${providerModelRateVersions.id} AND correction.effective_from <= ${occurredAt})`,
			),
		)
		.orderBy(asc(providerModelRateVersions.id))
		.limit(2);
}

/**
 * Resolve the governed price for one provider call directly against the rate
 * table — the dispatch-side equivalent of apps/api's `priceProviderUsage`,
 * minus the fleet-authority env (a Worker holding the platform DB is already
 * inside the rate authority). Unresolvable usage returns a reason, never a
 * fabricated zero.
 */
export async function resolveDirectProviderUsagePrice(
	db: DbQueryClient,
	identity: {
		provider: string;
		modelId: string;
		deploymentScope: string;
		occurredAt: string;
	},
	usage: ProviderTokenUsage,
): Promise<{
	costUsd: number | null;
	rateVersionId: string | null;
	reason: string | null;
}> {
	if (
		[
			usage.inputTokens,
			usage.outputTokens,
			usage.cacheReadTokens,
			usage.cacheWriteTokens,
		].some(
			(value) =>
				value === null ||
				typeof value !== "number" ||
				!Number.isSafeInteger(value) ||
				value < 0,
		) ||
		usage.cacheReadTokens! + usage.cacheWriteTokens! > usage.inputTokens!
	) {
		return { costUsd: null, rateVersionId: null, reason: "invalid_usage" };
	}
	const rows = await findProviderModelRates(db, {
		...identity,
		inputTokens: usage.inputTokens ?? 0,
	});
	if (rows.length !== 1) {
		return {
			costUsd: null,
			rateVersionId: null,
			reason: rows.length === 0 ? "missing_rate" : "ambiguous_rate",
		};
	}
	const micros = computeCostMicros(rows[0]!, usage);
	return {
		costUsd: micros === null ? null : Number(micros) / 1_000_000,
		rateVersionId: rows[0]!.id,
		reason: micros === null ? "invalid_usage" : null,
	};
}

/** Current list-price estimates use published rows without rewriting historical usage. */
export async function listEffectiveProviderModelRates(
	db: DbQueryClient,
	input: {
		provider: string;
		deploymentScope: string;
		occurredAt: string;
	},
) {
	return db
		.select()
		.from(providerModelRateVersions)
		.where(
			and(
				eq(providerModelRateVersions.provider, input.provider),
				eq(providerModelRateVersions.deploymentScope, input.deploymentScope),
				lte(providerModelRateVersions.effectiveFrom, input.occurredAt),
				sql`NOT EXISTS (SELECT 1 FROM provider_model_rate_versions AS correction WHERE correction.supersedes_rate_version_id = ${providerModelRateVersions.id} AND correction.effective_from <= ${input.occurredAt})`,
			),
		)
		.limit(1000);
}
