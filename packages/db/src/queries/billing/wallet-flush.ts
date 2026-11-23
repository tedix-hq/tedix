/** Posts a wallet's aggregated Code Mode charges to the D1 credit pool. */

import {
	DYNAMIC_WORKER_COST_USD_MICROS,
	DYNAMIC_WORKER_PROVIDER,
} from "@tedix/api-contract/utils/credit-pricing";
import type { DbClient } from "../../client";
import { buildCreditConsumptionStatements } from "./credit-pool";
import { recordBillingProviderUsage } from "./provider-usage";

export interface WalletFlushGroup {
	/** Stable within one flush: (period, tedi, member). */
	key: string;
	tediId: string | null;
	userId: string | null;
	periodStart: string;
	periodEnd: string;
	credits: number;
	anonymousLoads: number;
	namedLoads: number;
	runs: number;
	firstAt: string;
}

/**
 * One consumption per group in one batch, then provider usage per load
 * identity for the daily Cloudflare reconciliation. Every source ref derives
 * from the flush id, so a retried flush records nothing twice.
 */
export async function postWalletCodeRunFlush(
	db: DbClient,
	input: {
		organizationId: string;
		flushId: string;
		groups: WalletFlushGroup[];
		now: string;
	},
): Promise<void> {
	const statements = input.groups.flatMap((group) =>
		buildCreditConsumptionStatements(db, {
			id: crypto.randomUUID(),
			organizationId: input.organizationId,
			kind: "code_run",
			sourceRef: `wallet:${input.flushId}:${group.key}`,
			tediId: group.tediId,
			userId: group.userId,
			periodStart: group.periodStart,
			periodEnd: group.periodEnd,
			credits: group.credits,
			now: input.now,
		}),
	);
	if (statements.length > 0)
		await db.batch(statements as unknown as Parameters<typeof db.batch>[0]);
	for (const group of input.groups) {
		for (const [identity, quantity] of [
			["anonymous", group.anonymousLoads],
			["named", group.namedLoads],
		] as const) {
			if (quantity === 0) continue;
			await recordBillingProviderUsage(db, {
				id: crypto.randomUUID(),
				organizationId: input.organizationId,
				tediId: group.tediId,
				providerUsageId: `wallet:${input.flushId}:${group.key}:${identity}`,
				provider: DYNAMIC_WORKER_PROVIDER,
				model: "dynamic-worker",
				usageKind: "other",
				unit: "units",
				quantity,
				providerCostMicros: quantity * DYNAMIC_WORKER_COST_USD_MICROS,
				providerCostQuality: "estimated",
				occurredAt: group.firstAt,
				now: input.now,
				metadata: { surface: "gateway_model_code", identity, runs: group.runs },
			});
		}
	}
}
