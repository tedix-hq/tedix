/** Canonical D1-owned daily inference-capacity pack catalog. */

import { and, desc, eq, inArray, lte } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	type BillingInferenceCapacityPackVersion,
	billingInferenceCapacityPackVersions,
} from "../../schema/billing";

export async function listActiveInferenceCapacityPacks(
	db: DbClient,
	input: { stripeEnvironment: "test" | "live"; now: string },
): Promise<BillingInferenceCapacityPackVersion[]> {
	return db
		.select()
		.from(billingInferenceCapacityPackVersions)
		.where(
			and(
				eq(
					billingInferenceCapacityPackVersions.stripeEnvironment,
					input.stripeEnvironment,
				),
				eq(billingInferenceCapacityPackVersions.status, "active"),
				lte(billingInferenceCapacityPackVersions.effectiveAt, input.now),
			),
		)
		.orderBy(
			billingInferenceCapacityPackVersions.priceMicros,
			billingInferenceCapacityPackVersions.packKey,
		);
}

export async function getActiveInferenceCapacityPackByKey(
	db: DbClient,
	input: {
		packKey: string;
		stripeEnvironment: "test" | "live";
		now: string;
	},
): Promise<BillingInferenceCapacityPackVersion | null> {
	const [pack] = await db
		.select()
		.from(billingInferenceCapacityPackVersions)
		.where(
			and(
				eq(billingInferenceCapacityPackVersions.packKey, input.packKey),
				eq(
					billingInferenceCapacityPackVersions.stripeEnvironment,
					input.stripeEnvironment,
				),
				eq(billingInferenceCapacityPackVersions.status, "active"),
				lte(billingInferenceCapacityPackVersions.effectiveAt, input.now),
			),
		)
		.orderBy(desc(billingInferenceCapacityPackVersions.version))
		.limit(1);
	return pack ?? null;
}

export async function getInferenceCapacityPackVersionById(
	db: DbClient,
	input: { id: string; stripeEnvironment: "test" | "live" },
): Promise<BillingInferenceCapacityPackVersion | null> {
	const [pack] = await db
		.select()
		.from(billingInferenceCapacityPackVersions)
		.where(
			and(
				eq(billingInferenceCapacityPackVersions.id, input.id),
				eq(
					billingInferenceCapacityPackVersions.stripeEnvironment,
					input.stripeEnvironment,
				),
				inArray(billingInferenceCapacityPackVersions.status, [
					"active",
					"retired",
				]),
			),
		)
		.limit(1);
	return pack ?? null;
}
