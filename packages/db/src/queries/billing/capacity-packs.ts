/** Canonical D1-owned daily inference-capacity pack catalog. */

import type { CoreStoreBinding } from "../postgres/core-store";
import type { PgQueryClient } from "../../pg/query-client";
import { and, desc, eq, inArray, lte } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	type BillingInferenceCapacityPackVersion,
	billingInferenceCapacityPackVersions,
} from "../../schema/billing";

export async function listActiveInferenceCapacityPacks(
	db: DbClient | CoreStoreBinding<PgQueryClient>,
	input: { stripeEnvironment: "test" | "live"; now: string },
): Promise<BillingInferenceCapacityPackVersion[]> {
	if ("plane" in db) {
		if (db.plane === "postgres")
			return (
				await import("../../pg/queries/billing/capacity-packs")
			).listActiveInferenceCapacityPacks(db.db, input);
		db = db.db;
	}

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
	db: DbClient | CoreStoreBinding<PgQueryClient>,
	input: {
		packKey: string;
		stripeEnvironment: "test" | "live";
		now: string;
	},
): Promise<BillingInferenceCapacityPackVersion | null> {
	if ("plane" in db) {
		if (db.plane === "postgres")
			return (
				await import("../../pg/queries/billing/capacity-packs")
			).getActiveInferenceCapacityPackByKey(db.db, input);
		db = db.db;
	}

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
	db: DbClient | CoreStoreBinding<PgQueryClient>,
	input: { id: string; stripeEnvironment: "test" | "live" },
): Promise<BillingInferenceCapacityPackVersion | null> {
	if ("plane" in db) {
		if (db.plane === "postgres")
			return (
				await import("../../pg/queries/billing/capacity-packs")
			).getInferenceCapacityPackVersionById(db.db, input);
		db = db.db;
	}

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
