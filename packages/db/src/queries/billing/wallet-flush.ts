/** Posts a wallet's aggregated charges to the credit pool. */

import {
	DYNAMIC_WORKER_COST_USD_MICROS,
	DYNAMIC_WORKER_PROVIDER,
} from "@tedix/api-contract/utils/credit-pricing";
import { sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import { buildCreditConsumptionStatements } from "./credit-pool";
import { coreTable } from "../../core-store/client";
import { billingProviderUsage } from "../../schema/billing";

export interface WalletFlushGroup {
	/** Stable within one flush: (kind, period, tedi, member). */
	key: string;
	kind: "code_run" | "ai";
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
 * One batch records consumption per group and provider usage per load
 * identity for the daily Cloudflare reconciliation. Every source ref derives
 * from the flush id, so a retried flush records nothing twice.
 */
export async function postWalletFlush(
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
			kind: group.kind,
			sourceRef: `wallet:${input.flushId}:${group.key}`,
			tediId: group.tediId,
			userId: group.userId,
			periodStart: group.periodStart,
			periodEnd: group.periodEnd,
			credits: sql<number>`CAST(${group.credits} AS BIGINT)`,
			now: input.now,
		}),
	);
	const providerStatements = [];
	const usage = coreTable(db, billingProviderUsage);
	for (const group of input.groups) {
		for (const [identity, quantity] of [
			["anonymous", group.anonymousLoads],
			["named", group.namedLoads],
		] as const) {
			if (quantity === 0) continue;
			const providerCostMicros = quantity * DYNAMIC_WORKER_COST_USD_MICROS;
			if (
				!Number.isSafeInteger(quantity) ||
				quantity < 0 ||
				!Number.isSafeInteger(providerCostMicros) ||
				providerCostMicros < 0
			)
				throw new Error(
					"Provider usage requires positive integer quantity and non-negative integer cost micros",
				);
			providerStatements.push(
				db
					.insert(usage)
					.values({
						id: crypto.randomUUID(),
						organizationId: input.organizationId,
						tediId: group.tediId,
						providerUsageId: `wallet:${input.flushId}:${group.key}:${identity}`,
						provider: DYNAMIC_WORKER_PROVIDER,
						model: "dynamic-worker",
						usageKind: "other",
						unit: "units",
						quantity,
						providerCostMicros,
						providerCostQuality: "estimated",
						occurredAt: group.firstAt,
						createdAt: input.now,
						metadata: {
							surface: "gateway_model_code",
							identity,
							runs: group.runs,
						},
					})
					.onConflictDoNothing(),
			);
		}
	}
	const batch = [...statements, ...providerStatements];
	if (batch.length > 0)
		await db.batch(batch as unknown as Parameters<typeof db.batch>[0]);
}
