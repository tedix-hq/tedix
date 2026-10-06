/**
 * oRPC Tedix OS Compute Router
 *
 * The organization-scoped compute posture behind the OS "Compute and Models"
 * surface and every contextual cost chip. Read-only operator visibility, never
 * an invoice: invoices, destructive reconciliation, and secrets stay in the
 * administrative billing plane.
 *
 * Like `runtimeEntitlements.get` and `modelCatalog.list`, this handler reuses the
 * exact canonical readers the ENFORCING paths use — `getBillingBalanceSnapshot`
 * and `getRuntimeEntitlement` for budget, `buildModelCatalogProjection` for
 * routing — so the surface can never disagree with the gate that actually
 * blocks inference. Nothing is recomputed here.
 *
 * Every value it returns is labeled, and two of them are labeled as gaps:
 * model-provider health is `unknown` (no durable store), and unattributed cost
 * is a floor (NULL-org rows are invisible to an
 * org-scoped read). Saying so is the feature.
 */

import { implement } from "@orpc/server";
import type { CostProvenanceBucket } from "@tedix/api-contract/schemas/cost-provenance";
import {
	classifyCredentialHealth,
	classifyLedgerFreshness,
	COST_ATTRIBUTION_GAP_DETAIL,
	COST_ADMISSION_POLICY_DETAIL,
	COST_PROVIDER_HEALTH_DETAIL,
	type CostProvenance,
	ledgerRowProvenance,
	provenanceFloor,
} from "@tedix/api-contract/schemas/cost-provenance";
import { osComputeContract } from "@tedix/api-contract/contracts/os-compute";
import { getBillingBalanceSnapshot } from "@tedix/db/queries/billing/credits";
import { getEffectiveInferencePolicies } from "@tedix/db/queries/billing/inference-policies";
import { getAlertState } from "@tedix/db/queries/ops-alert-state";
import {
	getRuntimeEntitlement,
	runtimeEntitlementIsActive,
} from "@tedix/db/queries/runtime-entitlements";
import {
	getOrgCallCostProvenanceGroups,
	getOrgCostLedgerFreshness,
	type OrgCallCostProvenanceGroup,
} from "@tedix/db/queries/tedi-usage";
import { CLOUDFLARE_CREDENTIAL_CONDITION_KEY } from "../../lib/cloudflare-credential-health";
import { resolveAiGatewayAdmissionPolicy } from "../../services/ai-gateway-admission-policy";
import { buildModelCatalogProjection } from "../../services/model-catalog-projection";
import { requireOrgId } from "../org-scope";
import { AUTHZ, type BaseContext, withAuth } from "../orpc";

const os = implement(osComputeContract).$context<BaseContext>();

const WINDOW_DAYS = { "24h": 1, "7d": 7, "30d": 30 } as const;

/**
 * Roll the raw discriminating groups into per-provenance buckets using the ONE
 * contract-owned classifier. Buckets with no rows are omitted rather than
 * emitted as zeros: an absent label means "no row earned this label", which the
 * surface renders differently from "this label totalled nothing".
 */
export function provenanceBuckets(
	groups: readonly OrgCallCostProvenanceGroup[],
): CostProvenanceBucket[] {
	const buckets = new Map<CostProvenance, CostProvenanceBucket>();
	for (const group of groups) {
		// The group's SUMs are not the classifier's inputs — the classifier asks
		// only whether a price landed and whether tokens were spent, and the group
		// is keyed on exactly those two booleans, so every row inside it classifies
		// identically. Pass the booleans through as 1/0 rather than the sums, which
		// would let a group of small nonzero rows read as one large one.
		const provenance = ledgerRowProvenance({
			costBasis: group.costBasis,
			dataQuality: group.dataQuality,
			estimatedCostUsd: group.hasCost ? 0 : null,
		});
		const existing = buckets.get(provenance) ?? {
			provenance,
			rowCount: 0,
			totalTokens: 0,
			costUsd: 0 as number | null,
			knownSubtotalUsd: 0,
		};
		existing.rowCount += group.rowCount;
		existing.totalTokens += group.totalTokens;
		existing.knownSubtotalUsd += group.costUsd;
		existing.costUsd =
			existing.costUsd === null || !group.hasCost
				? null
				: existing.costUsd + group.costUsd;
		buckets.set(provenance, existing);
	}
	return [...buckets.values()].sort(
		(a, b) => b.knownSubtotalUsd - a.knownSubtotalUsd,
	);
}

/**
 * Split the window into spend and held-out value.
 *
 * Quarantined cost is reported BESIDE spend and never inside it — the same rule
 * `getCallCostTotals` enforces in SQL. `provenanceFloor` covers only the rows
 * that contributed to spend: a window whose only rows are quarantined has no
 * spend provenance at all, and returns null rather than claiming "quarantined
 * spend".
 */
export function spendTotals(buckets: readonly CostProvenanceBucket[]) {
	let pricedRowCount = 0;
	let unpricedRowCount = 0;
	let unpricedTokens = 0;
	let rowCount = 0;
	let totalTokens = 0;
	let costUsd = 0;
	let quarantinedCostUsd: number | null = 0;
	let quarantinedKnownSubtotalUsd = 0;
	let quarantinedTokens = 0;
	let quarantinedRowCount = 0;
	const contributing: CostProvenance[] = [];
	for (const bucket of buckets) {
		rowCount += bucket.rowCount;
		if (
			bucket.provenance === "unknown" ||
			bucket.provenance === "quarantined"
		) {
			unpricedRowCount += bucket.rowCount;
			unpricedTokens += bucket.totalTokens;
		} else pricedRowCount += bucket.rowCount;
		if (bucket.provenance === "quarantined") {
			quarantinedRowCount += bucket.rowCount;
			quarantinedTokens += bucket.totalTokens;
			quarantinedKnownSubtotalUsd += bucket.knownSubtotalUsd;
			quarantinedCostUsd =
				quarantinedCostUsd === null || bucket.costUsd === null
					? null
					: quarantinedCostUsd + bucket.costUsd;
			continue;
		}
		totalTokens += bucket.totalTokens;
		costUsd += bucket.knownSubtotalUsd;
		contributing.push(bucket.provenance);
	}
	return {
		rowCount,
		totalTokens,
		costUsd: pricedRowCount > 0 && unpricedRowCount === 0 ? costUsd : null,
		knownSubtotalUsd: costUsd,
		pricedRowCount,
		unpricedRowCount,
		unpricedTokens,
		costCompleteness:
			pricedRowCount === 0
				? ("unknown" as const)
				: unpricedRowCount > 0
					? ("partial" as const)
					: ("complete" as const),
		quarantinedCostUsd,
		quarantinedKnownSubtotalUsd,
		quarantinedTokens,
		quarantinedRowCount,
		provenanceFloor: provenanceFloor(contributing),
	};
}

/**
 * Unattributed cost that still carries this organization.
 *
 * A FLOOR, never a total: the `require_org_id_for_attributed_calls` trigger
 * permits a NULL `org_id` only on `unattributed` rows, and every org-scoped
 * read filters on `org_id`, so genuinely orphaned spend cannot appear here.
 * Quarantined unattributed rows are excluded from the dollar figure for the
 * same reason they are excluded from spend.
 */
export function attributionGap(groups: readonly OrgCallCostProvenanceGroup[]): {
	unattributedCostUsd: number;
	unattributedTokens: number;
	unattributedRowCount: number;
	unattributedQuarantinedRowCount: number;
	orphanedRowsVisible: false;
	detail: string;
} {
	let unattributedCostUsd = 0;
	let unattributedTokens = 0;
	let unattributedRowCount = 0;
	let unattributedQuarantinedRowCount = 0;
	for (const group of groups) {
		if (group.sessionType !== "unattributed") continue;
		// Counted apart from the contributing rows, not folded in with them: the
		// row count is rendered BESIDE the dollar figure, so including rows that
		// contributed nothing to it invited the reader to divide one by the other
		// and read a per-call rate that no row supports.
		if (group.dataQuality !== "ok") {
			unattributedQuarantinedRowCount += group.rowCount;
			continue;
		}
		unattributedRowCount += group.rowCount;
		unattributedTokens += group.totalTokens;
		unattributedCostUsd += group.costUsd;
	}
	return {
		unattributedCostUsd,
		unattributedTokens,
		unattributedRowCount,
		unattributedQuarantinedRowCount,
		orphanedRowsVisible: false,
		detail: COST_ATTRIBUTION_GAP_DETAIL,
	};
}

/**
 * The one fallback signal this system can honestly produce.
 *
 * The ledger's `provider` column records the serving provider. A
 * provider that served calls while the catalog selected a different one is a
 * detected divergence. We report the divergence and explicitly decline to
 * report a reason — reusing the catalog's own vocabulary for the selected side
 * rather than inventing a second one.
 */
export function fallbackDetail(
	selectedRef: string | null,
	observedProviders: readonly string[],
): string | null {
	if (selectedRef === null || observedProviders.length === 0) return null;
	const selectedProvider = selectedRef.split("/")[0] ?? null;
	if (selectedProvider === null) return null;
	const diverged = observedProviders.filter(
		(provider) => provider !== selectedProvider,
	);
	if (diverged.length === 0) return null;
	return `Calls in this window were served by ${diverged.join(", ")} while the model catalog selects ${selectedRef}. The cause and time of this provider divergence are unknown.`;
}

const posture = os.posture
	.use(withAuth)
	.use(AUTHZ.osRead)
	.handler(async ({ input, context }) => {
		const organizationId = requireOrgId(context);
		const now = new Date();
		const nowMs = now.getTime();
		const days = WINDOW_DAYS[input.window];
		const from = new Date(nowMs - days * 24 * 60 * 60 * 1000).toISOString();

		const [freshnessProbe, groups, balance, entitlement, policySources, alert] =
			await Promise.all([
				getOrgCostLedgerFreshness(context.db, organizationId, nowMs),
				getOrgCallCostProvenanceGroups(context.db, organizationId, from),
				getBillingBalanceSnapshot(
					context.db,
					organizationId,
					now.toISOString(),
				),
				getRuntimeEntitlement(context.db, organizationId),
				getEffectiveInferencePolicies(context.db, organizationId, null),
				getAlertState(context.db, CLOUDFLARE_CREDENTIAL_CONDITION_KEY),
			]);

		const catalog = await buildModelCatalogProjection({
			db: context.db,
			env: context.env,
			organizationId,
			tedi: null,
			includeDenied: true,
			nowMs,
		});

		const freshness = classifyLedgerFreshness(
			{
				lastRowAt: freshnessProbe.maxSnapshotAt,
				rowsLast24h: freshnessProbe.count24h,
				rowsLast30d: freshnessProbe.count30d,
			},
			nowMs,
		);
		const buckets = provenanceBuckets(groups);
		const observedProviders = [
			...new Set(
				groups
					.map((group) => group.provider)
					.filter((provider): provider is string => Boolean(provider)),
			),
		].sort();

		const orgPolicy = policySources
			? (resolveAiGatewayAdmissionPolicy(policySources).organization ?? null)
			: null;

		return {
			window: input.window,
			from,
			to: now.toISOString(),
			freshness,
			spend: spendTotals(buckets),
			provenance: buckets,
			budget: balance
				? {
						configured: true,
						includedTokens: balance.includedTokens,
						usedTokens: balance.usedTokens,
						reservedTokens: balance.reservedTokens,
						remainingIncludedTokens: balance.remainingIncludedTokens,
						allowOverage: balance.allowOverage,
						entitlementActive:
							entitlement === null
								? null
								: runtimeEntitlementIsActive(entitlement, nowMs),
						detail:
							"Copied from the canonical billing balance snapshot the admission path reads; remaining already nets out live reservations.",
					}
				: {
						configured: false,
						includedTokens: null,
						usedTokens: null,
						reservedTokens: null,
						remainingIncludedTokens: null,
						allowOverage: null,
						entitlementActive:
							entitlement === null
								? null
								: runtimeEntitlementIsActive(entitlement, nowMs),
						detail:
							"No billing account is configured for this organization, so no budget is known. This is not a zero balance.",
					},
			routing: {
				modelRef: catalog.routing.modelRef,
				selectedBy: catalog.routing.selectedBy,
				detail: catalog.routing.detail,
				allowedCount: catalog.models.filter((model) => model.allowed).length,
				deniedCount: catalog.models.filter((model) => !model.allowed).length,
				wiredProviders: [...catalog.wiredProviders],
				observedProviders,
				fallbackDetail: fallbackDetail(
					catalog.routing.modelRef,
					observedProviders,
				),
			},
			credentialHealth: classifyCredentialHealth({
				alert: alert
					? { status: alert.status, lastSeenAt: alert.lastSeenAt }
					: null,
				freshness,
			}),
			providerHealth: {
				status: "unknown" as const,
				detail: COST_PROVIDER_HEALTH_DETAIL,
			},
			admissionPolicy: {
				state: "d1_authoritative" as const,
				desiredDailyTokenLimit: orgPolicy?.dailyTokenLimit ?? null,
				desiredDailySpendLimitMicros: orgPolicy?.dailySpendLimitMicros ?? null,
				detail: COST_ADMISSION_POLICY_DETAIL,
			},
			attribution: attributionGap(groups),
		};
	});

export const osComputeContractRouter = os.router({ posture });
