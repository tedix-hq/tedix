import type { KernelExecutionAttempt } from "../rpc/routers/kernel/gateway-attribution";
import type { KernelPricingEvidence } from "@tedix/api-contract/schemas/cost-provenance";
import { providerDeploymentScope } from "@tedix/api-contract/schemas/provider-execution";
import {
	resolveFleetAuthorityDb,
	type FleetAuthorityEnv,
} from "../lib/fleet-authority";
import {
	computeCostMicros,
	type ProviderTokenUsage,
} from "@tedix/db/utils/model-pricing";
import {
	createProviderModelRateLookup,
	findProviderModelRates,
} from "@tedix/db/queries/billing/provider-model-rates";

/** Exact provider identity is required; no model-tail alias or mutable default. */
export async function resolveProviderModelRate(
	env: FleetAuthorityEnv,
	input: {
		provider: string;
		modelId: string;
		deploymentScope: string | null;
		occurredAt: string;
		/** Total prompt input tokens, including cache reads and writes. */
		inputTokens?: number;
	},
	lookup = findProviderModelRates,
) {
	if (input.deploymentScope === null || !input.deploymentScope.trim())
		return { status: "unpriced", reason: "ambiguous_scope" } as const;
	if (!Number.isFinite(Date.parse(input.occurredAt)))
		return { status: "unpriced", reason: "invalid_timestamp" } as const;
	let db;
	try {
		db = resolveFleetAuthorityDb(env);
	} catch {
		return {
			status: "unpriced",
			reason: "rate_authority_unavailable",
		} as const;
	}
	let rows;
	// A short D1 overload left calls unpriced for good: ingestion never
	// reprices a written row. Two quick retries ride out such a burst.
	for (let attempt = 0; ; attempt++) {
		try {
			rows = await lookup(db, {
				...input,
				deploymentScope: input.deploymentScope,
			});
			break;
		} catch {
			if (attempt === 2)
				return { status: "unpriced", reason: "rate_lookup_failed" } as const;
			await new Promise((resolve) => setTimeout(resolve, 250 * 4 ** attempt));
		}
	}
	if (rows.length === 0)
		return { status: "unpriced", reason: "missing_rate" } as const;
	if (rows.length !== 1)
		return { status: "unpriced", reason: "ambiguous_rate" } as const;
	return { status: "resolved", rate: rows[0]! } as const;
}

export async function priceProviderUsage(
	env: FleetAuthorityEnv,
	identity: Parameters<typeof resolveProviderModelRate>[1],
	usage: ProviderTokenUsage,
	lookup = findProviderModelRates,
) {
	if (
		[
			usage.inputTokens,
			usage.outputTokens,
			usage.cacheReadTokens,
			usage.cacheWriteTokens,
		].some(
			(value) =>
				typeof value !== "number" || !Number.isSafeInteger(value) || value < 0,
		) ||
		usage.inputTokens === null ||
		usage.cacheReadTokens === null ||
		usage.cacheWriteTokens === null ||
		usage.cacheReadTokens > usage.inputTokens - usage.cacheWriteTokens
	)
		return {
			costUsd: null,
			costMicros: null,
			rateVersionId: null,
			reason: "invalid_usage",
		};
	const resolved = await resolveProviderModelRate(
		env,
		{
			...identity,
			inputTokens: usage.inputTokens,
		},
		lookup,
	);
	if (resolved.status !== "resolved")
		return {
			costUsd: null,
			costMicros: null,
			rateVersionId: null,
			reason: resolved.reason,
		};
	const costMicros = computeCostMicros(resolved.rate, usage);
	const costUsd = costMicros === null ? null : Number(costMicros) / 1_000_000;
	return {
		costUsd,
		costMicros,
		rateVersionId: resolved.rate.id,
		reason: costUsd === null ? "invalid_usage" : null,
	};
}

/** Discard the rate snapshot after this ingestion, so later corrections are seen. */
export function createProviderUsagePricer(env: FleetAuthorityEnv) {
	let cached: ReturnType<typeof createProviderModelRateLookup> | undefined;
	const lookup: typeof findProviderModelRates = (db, input) => {
		cached ??= createProviderModelRateLookup(db);
		return cached(input);
	};
	return (
		identity: Parameters<typeof resolveProviderModelRate>[1],
		usage: ProviderTokenUsage,
	) => priceProviderUsage(env, identity, usage, lookup);
}

/** Every admitted send contributes evidence, even if its output failed validation. */
export async function priceKernelUsage(
	env: FleetAuthorityEnv,
	usage: { attempts: readonly KernelExecutionAttempt[] },
): Promise<{ costUsd: number | null; pricing: KernelPricingEvidence }> {
	const attempts = [
		...new Map(
			usage.attempts.map((attempt) => [attempt.executionId, attempt]),
		).values(),
	];
	if (attempts.length === 0)
		return {
			costUsd: 0,
			pricing: {
				knownSubtotalUsd: 0,
				attemptCount: 0,
				pricedAttemptCount: 0,
				costCompleteness: "no_usage",
				reason: null,
				executionId: null,
				rateVersionId: null,
			},
		};
	let subtotalMicros = 0n;
	let pricedAttemptCount = 0;
	let reason: string | null = null;
	const versions = new Set<string>();
	// One rate lookup per attempt, in flight together: a Home turn carries
	// three attempts (route call + two rankings) and the serial lookups were
	// ~0.3-0.45 s of the settlement window. Aggregation below keeps attempt
	// order, so the reported reason is unchanged.
	const pricedAttempts = await Promise.all(
		attempts.map((attempt) =>
			attempt.usage
				? priceProviderUsage(
						env,
						{
							provider: attempt.identity.provider,
							modelId: attempt.identity.requestModel,
							deploymentScope: providerDeploymentScope(attempt.identity),
							occurredAt: attempt.occurredAt,
						},
						attempt.usage,
					)
				: null,
		),
	);
	for (const [index, attempt] of attempts.entries()) {
		const priced = pricedAttempts[index];
		if (!attempt.usage || !priced) {
			reason ??= "missing_attempt_usage";
			continue;
		}
		if (priced.costUsd === null) {
			reason ??= priced.reason;
			continue;
		}
		const micros = priced.costMicros;
		if (
			micros === null ||
			subtotalMicros + micros > BigInt(Number.MAX_SAFE_INTEGER)
		) {
			reason = "cost_total_overflow";
			continue;
		}
		subtotalMicros += micros;
		pricedAttemptCount++;
		if (priced.rateVersionId) versions.add(priced.rateVersionId);
	}
	const knownSubtotalUsd = Number(subtotalMicros) / 1_000_000;
	const complete =
		attempts.length > 0 && pricedAttemptCount === attempts.length;
	return {
		costUsd: complete ? knownSubtotalUsd : null,
		pricing: {
			knownSubtotalUsd,
			attemptCount: attempts.length,
			pricedAttemptCount,
			costCompleteness: complete
				? "complete"
				: pricedAttemptCount > 0
					? "partial"
					: "unknown",
			reason: complete ? null : (reason ?? "missing_execution_usage"),
			executionId: attempts.length === 1 ? attempts[0]!.executionId : null,
			rateVersionId: versions.size === 1 ? [...versions][0]! : null,
		},
	};
}
