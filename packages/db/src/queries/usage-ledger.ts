import {
	normalizeEffectiveCallCost,
	effectiveCallCostsRelation,
	providerCostEvidenceProjection,
	sourceRetiredProjection,
} from "./billing/provider-cost-evidence";
import {
	and,
	desc,
	eq,
	gte,
	lt,
	lte,
	ne,
	or,
	getColumns,
	type SQL,
} from "drizzle-orm";
import { getLogStores, type DbClient } from "../client";
import { mergeLogStoreRows, readLogStores } from "../utils/log-store";
import { tediCallCosts, tedis, type TediCallCost } from "../schema/tedis";

export interface UsageLedgerFilters {
	organizationId: string;
	from?: string;
	to?: string;
	tediId?: string;
	source?: string;
	model?: string;
	includeUnattributed?: boolean;
	limit?: number;
	cursor?: {
		snapshotAt: string;
		id: string;
	};
}

export async function listOrgCallCostLedger(
	db: DbClient,
	filters: UsageLedgerFilters,
) {
	const stores = getLogStores(db);
	if (!stores) return readOrgCallCostLedger(db, filters);
	const conditions = callCostLedgerConditions(filters);
	const pages = await readLogStores(
		db,
		async (store) => {
			if (store === stores.main) return readOrgCallCostLedger(store, filters);
			const rows = await store
				.select()
				.from(tediCallCosts)
				.where(and(...conditions))
				.orderBy(desc(tediCallCosts.snapshotAt), desc(tediCallCosts.id))
				.limit(filters.limit ?? 500);
			// Hydrate small pages in main so tedis and reviewed evidence keep their
			// existing join semantics; a logs partition holds neither parent table.
			const hydrated: Awaited<ReturnType<typeof readOrgCallCostLedger>> = [];
			for (let start = 0; start < rows.length; start += 100) {
				hydrated.push(
					...(await readOrgCallCostLedger(
						stores.main,
						filters,
						effectiveCallCostsRelation(rows.slice(start, start + 100)),
					)),
				);
			}
			return hydrated;
		},
		{ from: filters.from, to: filters.to },
	);
	return mergeLogStoreRows(pages ?? [], {
		compare: (a, b) =>
			b.snapshotAt.localeCompare(a.snapshotAt) || b.id.localeCompare(a.id),
		limit: filters.limit ?? 500,
	});
}

function callCostLedgerConditions(filters: UsageLedgerFilters): SQL[] {
	// Organization attribution is stamped directly on gateway rows. Do not infer
	// it through tedis: kernel rows and valid org-attributed rows without a tedi
	// would disappear behind an inner join.
	const conditions: SQL[] = [eq(tediCallCosts.orgId, filters.organizationId)];

	if (filters.from)
		conditions.push(gte(tediCallCosts.snapshotAt, filters.from));
	if (filters.to) conditions.push(lte(tediCallCosts.snapshotAt, filters.to));
	if (filters.tediId) conditions.push(eq(tediCallCosts.tediId, filters.tediId));
	if (filters.source) conditions.push(eq(tediCallCosts.source, filters.source));
	if (filters.model) conditions.push(eq(tediCallCosts.model, filters.model));
	if (filters.includeUnattributed === false) {
		// "unattributed" is now a sessionType value (no tedi/kernel metadata on the
		// source gateway log row), not a sentinel `source` string.
		conditions.push(ne(tediCallCosts.sessionType, "unattributed"));
	}
	if (filters.cursor) {
		conditions.push(
			or(
				lt(tediCallCosts.snapshotAt, filters.cursor.snapshotAt),
				and(
					eq(tediCallCosts.snapshotAt, filters.cursor.snapshotAt),
					lt(tediCallCosts.id, filters.cursor.id),
				),
			)!,
		);
	}

	return conditions;
}

async function readOrgCallCostLedger(
	db: DbClient,
	filters: UsageLedgerFilters,
	relation = effectiveCallCostsRelation(),
) {
	const conditions = callCostLedgerConditions(filters);
	const rows = await db
		.select({
			...getColumns(tediCallCosts),
			id: tediCallCosts.id,
			providerCostEvidence: providerCostEvidenceProjection,
			sourceRetired: sourceRetiredProjection,
			tediId: tediCallCosts.tediId,
			tediName: tedis.name,
			tediSlug: tedis.slug,
			snapshotAt: tediCallCosts.snapshotAt,
			model: tediCallCosts.model,
			provider: tediCallCosts.provider,
			providerResource: tediCallCosts.providerResource,
			providerBaseUrl: tediCallCosts.providerBaseUrl,
			deployment: tediCallCosts.deployment,
			runId: tediCallCosts.runId,
			workItemId: tediCallCosts.workItemId,
			sessionKeyHash: tediCallCosts.sessionKeyHash,
			sessionType: tediCallCosts.sessionType,
			source: tediCallCosts.source,
			inputTokens: tediCallCosts.inputTokens,
			outputTokens: tediCallCosts.outputTokens,
			cacheReadTokens: tediCallCosts.cacheReadTokens,
			cacheWriteTokens: tediCallCosts.cacheWriteTokens,
			totalTokens: tediCallCosts.totalTokens,
			estimatedCostUsd: tediCallCosts.estimatedCostUsd,
			callDurationMs: tediCallCosts.callDurationMs,
			costBasis: tediCallCosts.costBasis,
			rateVersionId: tediCallCosts.rateVersionId,
			rawReportedCostUsd: tediCallCosts.rawReportedCostUsd,
			costReason: tediCallCosts.costReason,
			executionId: tediCallCosts.executionId,
			sessionCount: tediCallCosts.sessionCount,
			dataQuality: tediCallCosts.dataQuality,
			createdAt: tediCallCosts.createdAt,
		})
		.from(relation)
		.leftJoin(tedis, eq(tediCallCosts.tediId, tedis.id))
		.where(and(...conditions))
		.orderBy(desc(tediCallCosts.snapshotAt), desc(tediCallCosts.id))
		.limit(filters.limit ?? 500);
	return (
		rows as unknown as Array<
			TediCallCost & {
				tediName: string | null;
				tediSlug: string | null;
				providerCostEvidence: string | null;
				sourceRetired: number;
			}
		>
	).map(normalizeEffectiveCallCost);
}

export type OrgCallCostLedgerRow = Awaited<
	ReturnType<typeof listOrgCallCostLedger>
>[number];
