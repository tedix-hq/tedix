import type {
	HarnessPromotionStatus,
	PromotionDecision,
} from "@tedix/api-contract/schemas/harness-version";
import { decidePromotion } from "@tedix/api-contract/schemas/harness-version";
import { eq } from "drizzle-orm";
import type { DbClient } from "../../client";
import { harnessVersions } from "../../schema/harness-versions";
import { getEvalSummaryForVersion } from "./evaluations";
import {
	type JsonObject,
	optionalJsonObject,
	parseJsonObject,
} from "./persistence-json";

/**
 * Read-modify-write merge of partial keys into a harness version's `metadata`
 * JSON. Reads the current row, shallow-merges `patch` over the existing
 * metadata (existing keys not in `patch` are preserved), and writes it back —
 * never clobbers unrelated keys. Used by the live-turn scoring post-write stamp
 * (Slice B) to record `latestEval` + a `promotable` candidate MARK on the
 * version WITHOUT a schema migration (the column already exists) and WITHOUT
 * touching `promotion_status`. No-ops when the version does not exist.
 *
 * Returns the merged metadata that was written, or null when the row is absent.
 */
export async function updateHarnessVersionMetadata(
	db: DbClient,
	harnessVersionId: string,
	patch: Record<string, unknown>,
): Promise<JsonObject | null> {
	const row = (
		await db
			.select()
			.from(harnessVersions)
			.where(eq(harnessVersions.id, harnessVersionId))
			.limit(1)
	)[0];
	if (!row) return null;
	const current = optionalJsonObject(row.metadata, "harness_versions.metadata");
	const parsedPatch = parseJsonObject(patch, "harness version metadata patch");
	const merged: JsonObject = { ...current, ...parsedPatch };
	await db
		.update(harnessVersions)
		.set({ metadata: merged })
		.where(eq(harnessVersions.id, harnessVersionId));
	return merged;
}

/** Set a version's promotion status (the single-active invariant is owned by
 * `recordHarnessVersion`'s active-pointer logic; this is for ladder transitions). */
export async function updateHarnessPromotionStatus(
	db: DbClient,
	harnessVersionId: string,
	status: HarnessPromotionStatus,
): Promise<void> {
	await db
		.update(harnessVersions)
		.set({ promotionStatus: status })
		.where(eq(harnessVersions.id, harnessVersionId));
}

/**
 * Evaluate + advance one harness version through the promotion ladder from its
 * eval summary. Reads the version's current status, applies the pure
 * `decidePromotion`, and persists `nextStatus` only when it advances (including
 * the transition to `rejected`). Returns the decision + the status now stored.
 * No-ops safely when the version does not exist.
 */
export async function promoteHarnessVersion(
	db: DbClient,
	harnessVersionId: string,
): Promise<
	(PromotionDecision & { harnessVersionId: string; applied: boolean }) | null
> {
	const versionRow = (
		await db
			.select()
			.from(harnessVersions)
			.where(eq(harnessVersions.id, harnessVersionId))
			.limit(1)
	)[0];
	if (!versionRow) return null;

	const summary = await getEvalSummaryForVersion(db, harnessVersionId);
	const decision = decidePromotion(
		versionRow.promotionStatus as HarnessPromotionStatus,
		summary,
	);

	const applied = decision.advanced;
	if (applied) {
		await updateHarnessPromotionStatus(
			db,
			harnessVersionId,
			decision.nextStatus,
		);
	}
	return { ...decision, harnessVersionId, applied };
}
