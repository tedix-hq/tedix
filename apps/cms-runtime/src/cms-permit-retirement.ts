import type { DbQueryClient } from "@tedix/db/query-client";
import {
	deleteRetiredCmsRuntimePermits,
	type CmsRestorePermitParams,
} from "@tedix/db/queries/cms-restore-fences";

interface RuntimeRetirement {
	version: 1;
	currentRuntimeOwnerId: string;
	retiredRuntimeOwnerIds: string[];
	legacyPermits: CmsRestorePermitParams[];
	invocationsDrained: true;
	evidenceRef: string;
}

/** Private release custody, never tenant data or a request-supplied assertion.
 * Ship's operator must verify that no retired release serves traffic and that
 * its outstanding invocations drained before writing this immutable receipt.
 * Retirement is terminal; rolling back source requires a fresh build owner. */
export async function sweepRetiredCmsRuntimePermits(
	db: DbQueryClient,
	storage: R2Bucket,
	currentRuntimeOwnerId: string,
): Promise<number> {
	if (!/^[0-9a-f]{40}$/.test(currentRuntimeOwnerId)) return 0;
	const object = await storage.get(
		`runtime-permit-retirements/v1/${currentRuntimeOwnerId}.json`,
	);
	if (!object) return 0;
	const receipt = await object.json<RuntimeRetirement>();
	if (
		receipt.version !== 1 ||
		receipt.currentRuntimeOwnerId !== currentRuntimeOwnerId ||
		receipt.invocationsDrained !== true ||
		typeof receipt.evidenceRef !== "string" ||
		!receipt.evidenceRef.trim() ||
		!Array.isArray(receipt.retiredRuntimeOwnerIds) ||
		receipt.retiredRuntimeOwnerIds.length > 100 ||
		!Array.isArray(receipt.legacyPermits) ||
		receipt.legacyPermits.length > 10_000 ||
		receipt.legacyPermits.some(
			(permit) =>
				!permit ||
				typeof permit.permitId !== "string" ||
				permit.permitId.startsWith("runtime:") ||
				typeof permit.siteId !== "string" ||
				typeof permit.slug !== "string" ||
				!Number.isSafeInteger(permit.restoreEpoch) ||
				permit.restoreEpoch < 0 ||
				!["outer", "nested", "scheduled"].includes(permit.kind),
		)
	)
		throw new Error("CMS runtime retirement receipt invalid");
	const removed = await deleteRetiredCmsRuntimePermits(db, {
		...receipt,
		limit: 1_000,
	});
	if (removed.length)
		console.info("[cms-runtime] retired restore permits reclaimed", {
			evidenceRef: receipt.evidenceRef,
			byKind: removed.reduce<Record<string, number>>((counts, permit) => {
				counts[permit.kind] = (counts[permit.kind] ?? 0) + 1;
				return counts;
			}, {}),
			removed: removed.length,
		});
	return removed.length;
}
