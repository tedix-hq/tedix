import type { RuntimeEntitlementGrant } from "@tedix/api-contract/schemas/runtime-entitlements";
import { eq, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import { coreTable } from "../core-store/client";
import {
	billingAccounts as schemaBillingAccounts,
	billingPlanVersions as schemaBillingPlanVersions,
} from "../schema/billing";

export interface RuntimeEntitlementResult {
	organizationId: string;
	status: "trial" | "active" | "past_due" | "cancelled" | "suspended";
	effectivePeriod: { startsAt: string; endsAt: string };
	profile: { key: string; name: string };
	limits: {
		includedMonthlyCredits: number;
		maxTedis: number;
		maxCronJobsPerTedi: number;
		maxIterationsPerTask: number;
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

/** The entitlement read as one composable statement for spend admission batches. */
export function runtimeEntitlementQuery(db: DbClient, organizationId: string) {
	const billingAccounts = coreTable(db, schemaBillingAccounts);
	const billingPlanVersions = coreTable(db, schemaBillingPlanVersions);
	const runtimeEntitlementColumns = {
		organizationId: billingAccounts.organizationId,
		entitlementStatus: billingAccounts.status,
		effectiveStartsAt: billingAccounts.periodStart,
		effectiveEndsAt: billingAccounts.periodEnd,
		entitlementVersion: billingAccounts.entitlementVersion,
		entitlementMetadata: billingAccounts.metadata,
		profileKey: billingPlanVersions.planKey,
		profileName: billingPlanVersions.name,
		includedMonthlyCredits:
			sql<number>`COALESCE(${billingAccounts.includedCreditsOverride}, ${billingPlanVersions.includedMonthlyCredits})`.as(
				"included_monthly_credits",
			),
		maxTedis: billingPlanVersions.maxTedis,
		maxCronJobsPerTedi: billingPlanVersions.maxCronJobsPerTedi,
		maxIterationsPerTask: billingPlanVersions.maxIterationsPerTask,
	} as const;
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
			includedMonthlyCredits: Number(row.includedMonthlyCredits),
			maxTedis: row.maxTedis,
			maxCronJobsPerTedi: row.maxCronJobsPerTedi,
			maxIterationsPerTask: row.maxIterationsPerTask,
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
