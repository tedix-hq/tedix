/**
 * The reads spend admission needs, in one D1 round-trip.
 *
 * Admission runs before EVERY provider request — several times per embedded
 * turn — and it used to issue five serial reads: the entitlement, then inside
 * the policy resolver a second read of the same
 * `billingAccounts`/`billingPlanVersions` rows, the organization policy, a tedi
 * ownership check, and the tedi policy. No individual query was slow; the cost
 * was purely that they waited for each other, one D1 round-trip each, which is
 * why it never tracked payload size.
 *
 * `db.batch()` is D1's transaction primitive — `db.transaction()` is refused
 * with error 7500 — so one batch is both the fix and the supported idiom.
 *
 * Two consequences of batching, both deliberate:
 *
 * - The entitlement's `defaultDailyTokenLimit` already comes from the plan
 *   version, so the policy resolver's own read of those rows is not just
 *   serialized here, it is redundant. It is gone rather than batched.
 * - Reads that the serial version would have skipped now always run: an
 *   organization with no billing account still reads its policy row, and a tedi
 *   that fails the ownership check still reads its policy row. Those are the
 *   denial branches, they are rare, and the caller's CHECK order is unchanged —
 *   a denial is still a denial with the same code. Only wasted reads, never a
 *   different answer.
 *
 * Every statement here selects from a single table except the entitlement's
 * join, which selects one aliased column per source, so no statement can hit
 * D1's duplicate-output-name hazard when its rows come back as objects.
 */

import type { DbClient } from "../../client";
import {
	type RuntimeEntitlementResult,
	runtimeEntitlementFromRow,
	runtimeEntitlementQuery,
} from "../runtime-entitlements";
import {
	type EffectiveInferencePolicies,
	inferencePolicyQuery,
	organizationInferencePolicy,
	tediInferencePolicy,
	tediOwnershipQuery,
} from "./inference-policies";

export interface InferenceAdmissionReads {
	entitlement: RuntimeEntitlementResult | null;
	/**
	 * Null exactly when the entitlement is null, matching what the serial
	 * resolver returned when its own account read found nothing.
	 */
	policies: EffectiveInferencePolicies | null;
}

export async function getInferenceAdmissionReads(
	db: DbClient,
	organizationId: string,
	tediId?: string | null,
): Promise<InferenceAdmissionReads> {
	const entitlementStatement = runtimeEntitlementQuery(db, organizationId);
	const organizationStatement = inferencePolicyQuery(
		db,
		organizationId,
		"organization",
		"organization",
	);
	// A null tediId means "organization scope only". Batching the tedi reads
	// anyway would send a statement whose parameter does not exist.
	const [entitlementRows, organizationRows, tediRows, tediPolicyRows] =
		tediId == null
			? [
					...(await db.batch([entitlementStatement, organizationStatement])),
					[],
					[],
				]
			: await db.batch([
					entitlementStatement,
					organizationStatement,
					tediOwnershipQuery(db, organizationId, tediId),
					inferencePolicyQuery(db, organizationId, "tedi", tediId),
				]);

	const entitlement = runtimeEntitlementFromRow(entitlementRows[0]);
	if (!entitlement) return { entitlement: null, policies: null };

	const organization = organizationInferencePolicy(
		entitlement.limits.defaultDailyTokenLimit,
		organizationRows[0],
	);
	if (tediId == null)
		return { entitlement, policies: { organization, tediFound: true } };
	if (!tediRows[0])
		return { entitlement, policies: { organization, tediFound: false } };
	return {
		entitlement,
		policies: {
			organization,
			tedi: tediInferencePolicy(tediPolicyRows[0]),
			tediFound: true,
		},
	};
}
