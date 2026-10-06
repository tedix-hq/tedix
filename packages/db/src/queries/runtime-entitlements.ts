import type { RuntimeEntitlementGrant } from "@tedix/api-contract/schemas/runtime-entitlements";
import { eq } from "drizzle-orm";
import type { DbClient } from "../client";
import { billingAccounts, billingPlanVersions } from "../schema/billing";

export interface RuntimeEntitlementResult {
	organizationId: string;
	status: "trial" | "active" | "past_due" | "cancelled" | "suspended";
	effectivePeriod: { startsAt: string; endsAt: string };
	profile: { key: string; name: string };
	limits: {
		includedMonthlyTokens: number;
		maxTedis: number;
		maxCronJobsPerTedi: number;
		maxIterationsPerTask: number;
		defaultDailyTokenLimit: number;
		defaultDailyMessageLimit: number;
	};
	grants: RuntimeEntitlementGrant[];
	source: "installation" | "managed-plan" | "external" | "operator";
	version: number;
}

function runtimeMetadata(value: unknown): {
	grants: RuntimeEntitlementGrant[];
	source: RuntimeEntitlementResult["source"];
} {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { grants: [], source: "managed-plan" };
	}
	const metadata = value as Record<string, unknown>;
	const source =
		metadata.runtimeEntitlementSource === "installation" ||
		metadata.runtimeEntitlementSource === "external" ||
		metadata.runtimeEntitlementSource === "operator"
			? metadata.runtimeEntitlementSource
			: "managed-plan";
	const grants = Array.isArray(metadata.runtimeEntitlementGrants)
		? metadata.runtimeEntitlementGrants.filter(
				(grant): grant is RuntimeEntitlementGrant =>
					Boolean(
						grant &&
						typeof grant === "object" &&
						!Array.isArray(grant) &&
						typeof (grant as Record<string, unknown>).key === "string" &&
						["active", "inactive"].includes(
							String((grant as Record<string, unknown>).status),
						) &&
						["license", "managed-plan", "operator", "internal"].includes(
							String((grant as Record<string, unknown>).source),
						),
					),
			)
		: [];
	return { grants, source };
}

/**
 * The entitlement projection's columns, separated from the await so a caller
 * that needs this read inside a `db.batch()` composes the same statement rather
 * than restating it. Spend admission does exactly that.
 */
export const runtimeEntitlementColumns = {
	organizationId: billingAccounts.organizationId,
	entitlementStatus: billingAccounts.status,
	effectiveStartsAt: billingAccounts.periodStart,
	effectiveEndsAt: billingAccounts.periodEnd,
	entitlementVersion: billingAccounts.entitlementVersion,
	entitlementMetadata: billingAccounts.metadata,
	profileKey: billingPlanVersions.planKey,
	profileName: billingPlanVersions.name,
	includedMonthlyTokens: billingPlanVersions.includedMonthlyTokens,
	maxTedis: billingPlanVersions.maxTedis,
	maxCronJobsPerTedi: billingPlanVersions.maxCronJobsPerTedi,
	maxIterationsPerTask: billingPlanVersions.maxIterationsPerTask,
	defaultDailyTokenLimit: billingPlanVersions.defaultDailyTokenLimit,
	defaultDailyMessageLimit: billingPlanVersions.defaultDailyMessageLimit,
} as const;

/** The entitlement read as one composable statement. */
export function runtimeEntitlementQuery(db: DbClient, organizationId: string) {
	return db
		.select(runtimeEntitlementColumns)
		.from(billingAccounts)
		.innerJoin(
			billingPlanVersions,
			eq(billingAccounts.planVersionId, billingPlanVersions.id),
		)
		.where(eq(billingAccounts.organizationId, organizationId))
		.limit(1);
}

type RuntimeEntitlementRow = Awaited<
	ReturnType<typeof runtimeEntitlementQuery>
>[number];

/** Shape one entitlement row. Returns null for the absent-account case. */
export function runtimeEntitlementFromRow(
	row: RuntimeEntitlementRow | undefined,
): RuntimeEntitlementResult | null {
	if (!row) return null;

	const metadata = runtimeMetadata(row.entitlementMetadata);
	return {
		organizationId: row.organizationId,
		status: row.entitlementStatus,
		effectivePeriod: {
			startsAt: row.effectiveStartsAt,
			endsAt: row.effectiveEndsAt,
		},
		profile: { key: row.profileKey, name: row.profileName },
		limits: {
			includedMonthlyTokens: row.includedMonthlyTokens,
			maxTedis: row.maxTedis,
			maxCronJobsPerTedi: row.maxCronJobsPerTedi,
			maxIterationsPerTask: row.maxIterationsPerTask,
			defaultDailyTokenLimit: row.defaultDailyTokenLimit,
			defaultDailyMessageLimit: row.defaultDailyMessageLimit,
		},
		grants: metadata.grants,
		source: metadata.source,
		version: row.entitlementVersion,
	};
}

/**
 * Provider-neutral runtime entitlement projection.
 *
 * The existing billing tables remain temporary physical backing, but this
 * select deliberately excludes settlement provider IDs, environments, prices,
 * rates, balances, charges, and billing modes.
 */
export async function getRuntimeEntitlement(
	db: DbClient,
	organizationId: string,
): Promise<RuntimeEntitlementResult | null> {
	const [row] = await runtimeEntitlementQuery(db, organizationId);
	return runtimeEntitlementFromRow(row);
}

export function runtimeEntitlementIsActive(
	entitlement: RuntimeEntitlementResult,
	nowMs: number,
): boolean {
	return (
		(entitlement.status === "trial" || entitlement.status === "active") &&
		nowMs >= Date.parse(entitlement.effectivePeriod.startsAt) &&
		nowMs < Date.parse(entitlement.effectivePeriod.endsAt)
	);
}
