/** Immutable provider-rate publication and event-time lookup. */
import { and, asc, eq, gt, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { PgQueryClient } from "../../query-client";
import {
	providerModelRateVersions,
	type NewProviderModelRateVersionRow,
} from "../../schema/provider-model-rates";
import {
	computeCostMicros,
	type ProviderTokenUsage,
} from "../../../utils/model-pricing";

export interface PublishProviderModelRateParams extends NewProviderModelRateVersionRow {}

/** Serialize publication for an exact provider/model/deployment key, including empty histories. */
export async function publishProviderModelRate(
	db: PgQueryClient,
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
	if (verified > published) return null;
	return db.transaction(async (tx) => {
		// JSON encoding preserves tuple boundaries even when identifiers contain separators.
		const key = JSON.stringify([
			"provider-model-rate",
			input.provider,
			input.modelId,
			input.deploymentScope,
		]);
		await tx.execute(
			sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
		);
		const [overlap] = await tx
			.select({ id: providerModelRateVersions.id })
			.from(providerModelRateVersions)
			.where(
				and(
					eq(providerModelRateVersions.provider, input.provider),
					eq(providerModelRateVersions.modelId, input.modelId),
					eq(providerModelRateVersions.deploymentScope, input.deploymentScope),
					prior === null ? undefined : ne(providerModelRateVersions.id, prior),
					or(
						isNull(providerModelRateVersions.inputTokenMax),
						gt(providerModelRateVersions.inputTokenMax, tokenMin),
					),
					tokenMax === null
						? undefined
						: sql`${providerModelRateVersions.inputTokenMin} < ${tokenMax}`,
					sql`NOT EXISTS (SELECT 1 FROM provider_model_rate_versions AS correction WHERE correction.supersedes_rate_version_id = ${providerModelRateVersions.id} AND correction.effective_from <= ${from})`,
				),
			)
			.limit(1);
		if (overlap) return null;
		if (prior === null) {
			if (from <= published) return null;
		} else {
			const [original] = await tx
				.select()
				.from(providerModelRateVersions)
				.where(
					and(
						eq(providerModelRateVersions.id, prior),
						eq(providerModelRateVersions.provider, input.provider),
						eq(providerModelRateVersions.modelId, input.modelId),
						eq(
							providerModelRateVersions.deploymentScope,
							input.deploymentScope,
						),
						eq(providerModelRateVersions.inputTokenMin, tokenMin),
						tokenMax === null
							? isNull(providerModelRateVersions.inputTokenMax)
							: eq(providerModelRateVersions.inputTokenMax, tokenMax),
						sql`NOT EXISTS (SELECT 1 FROM provider_model_rate_versions AS correction WHERE correction.supersedes_rate_version_id = ${providerModelRateVersions.id})`,
					),
				)
				.limit(1);
			if (
				!original ||
				!(
					original.effectiveFrom === from ||
					(from > published && from > original.effectiveFrom)
				)
			)
				return null;
		}
		const [row] = await tx
			.insert(providerModelRateVersions)
			.values({
				...input,
				inputTokenMin: tokenMin,
				inputTokenMax: tokenMax,
				effectiveFrom: from,
				publishedAt: published,
				verifiedAt: verified,
				supersedesRateVersionId: prior,
			})
			.returning();
		return row ?? null;
	});
}

export async function listProviderModelRates(
	db: PgQueryClient,
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
	db: PgQueryClient,
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
				sql`${providerModelRateVersions.inputTokenMin}::bigint <= ${inputTokens}::bigint`,
				sql`(${providerModelRateVersions.inputTokenMax} IS NULL OR ${providerModelRateVersions.inputTokenMax}::bigint > ${inputTokens}::bigint)`,
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
	db: PgQueryClient,
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
	db: PgQueryClient,
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
