import { and, eq, getColumns, getTableName, sql, Subquery } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/sqlite-core";
import {
	ProviderCostEvidenceProjectionSchema,
	type ProviderCostEvidenceProjection,
} from "@tedix/api-contract/schemas/provider-cost-evidence";
import type { DbClient } from "../../client";
import { coreTable } from "../../core-store/client";
import { coreStore, pgTextArray } from "../../core-store/dialect";
import { readLogStores, mergeLogStoreRows } from "../../utils/log-store";
import { getProviderExecutionsByIds } from "../provider-executions";
import {
	billingProviderCostEvidenceVersions as evidence,
	billingUsageReservations,
	billingUsageQuarantines,
} from "../../schema/billing";
import { providerExecutionAttempts } from "../../schema/provider-executions";
import { tediCallCosts } from "../../schema/tedis";
import {
	workApprovalDecisions,
	workApprovalProposals,
	workAdmissions,
	workResourceRequirements,
	workResourceReservations,
} from "../../schema/work-factory";
import {
	workItems,
	workItemStoredColumns,
	workAttempts,
} from "../../schema/work-items";

export type ProviderCostEvidenceRow = typeof evidence.$inferSelect;
export type NewProviderCostEvidenceRow = typeof evidence.$inferInsert;

/** Cast target for a JSON-extracted value, matching the physical column type. */
function pgCast(sqlType: string | null | undefined): string | null {
	switch (sqlType) {
		case "bigint":
		case "integer":
		case "smallint":
			return "bigint";
		case "double precision":
		case "real":
			return "double precision";
		case "numeric":
			return "numeric";
		case "boolean":
			return "boolean";
		case "json":
		case "jsonb":
			return "jsonb";
		case "timestamp with time zone":
			return "timestamptz";
		case "timestamp without time zone":
			return "timestamp";
		default:
			return null;
	}
}

type CoreTable = Parameters<typeof getTableName>[0];

/** `getSQLType()` of the Postgres column behind a SQLite schema table. */
function pgColumnType(
	db: object,
	table: CoreTable,
	key: string,
): string | null {
	const columns = getColumns(coreTable(db, table)) as Record<
		string,
		{ getSQLType?: () => string }
	>;
	return columns[key]?.getSQLType?.() ?? null;
}

/** `value` extracted from a JSON document, typed for Postgres when `table` is given. */
function snapshotValue(
	db: object | undefined,
	document: ReturnType<typeof sql>,
	table: CoreTable | undefined,
	key: string,
	asJson = false,
) {
	if (db !== undefined && coreStore(db) === "postgres") {
		const read = asJson
			? sql`${document} -> ${sql.raw(`'${key}'`)}`
			: sql`${document} ->> ${sql.raw(`'${key}'`)}`;
		const cast =
			asJson || table === undefined
				? null
				: pgCast(pgColumnType(db, table, key));
		return cast ? sql`(${read})::${sql.raw(cast)}` : read;
	}
	return sql`json_extract(${document}, ${sql.raw(`'$.${key}'`)})`;
}
export type EffectiveTediCallCost = typeof tediCallCosts.$inferSelect & {
	providerCostEvidence: ProviderCostEvidenceProjection | null;
	sourceRetired: boolean;
};
export function normalizeEffectiveCallCost<
	T extends typeof tediCallCosts.$inferSelect,
>(
	row: T & { providerCostEvidence: string | null; sourceRetired: number },
): Omit<T, "providerCostEvidence" | "sourceRetired"> & {
	providerCostEvidence: ProviderCostEvidenceProjection | null;
	sourceRetired: boolean;
} {
	if (row.sourceRetired !== 0 && row.sourceRetired !== 1)
		throw new Error("Invalid retired source flag");
	return {
		...row,
		sourceRetired: row.sourceRetired === 1,
		providerCostEvidence:
			row.providerCostEvidence === null
				? null
				: ProviderCostEvidenceProjectionSchema.parse(
						JSON.parse(row.providerCostEvidence),
					),
	};
}

/** One row per original call, including retained snapshots whose source was deleted. */
export function effectiveCallCostsRelation(
	archivedRows?: readonly (typeof tediCallCosts.$inferSelect)[],
	db?: object,
) {
	const postgres = db !== undefined && coreStore(db) === "postgres";
	const columns = Object.entries(getColumns(tediCallCosts));
	const original = sql.join(
		columns.map(
			([, c]) =>
				sql`original.${sql.identifier(c.name)} AS ${sql.identifier(c.name)}`,
		),
		sql`, `,
	);
	const document = sql`leaf.original_source_snapshot`;
	// Raw: literal JSON paths keep this relation inside D1's 100-parameter limit
	// wherever it is embedded; the CTE + UNION ALL is exposed as a shadowing
	// Subquery that the builders cannot construct with these output names.
	const retired = sql.join(
		columns.map(
			([key, c]) =>
				sql`${snapshotValue(db, document, tediCallCosts, key)} AS ${sql.identifier(c.name)}`,
		),
		sql`, `,
	);
	// Archived pages are filtered and bounded in their store. Join their original
	// values to authority in main; authority tables never move to the logs DB.
	const archiveSource =
		archivedRows === undefined
			? null
			: postgres
				? sql`(SELECT ${sql.join(
						columns.map(
							([key, c]) =>
								sql`${snapshotValue(db, sql`value`, tediCallCosts, key)} AS ${sql.identifier(c.name)}`,
						),
						sql`, `,
					)} FROM jsonb_array_elements(${JSON.stringify(archivedRows)}::jsonb) AS archived(value))`
				: new QueryBuilder()
						.select(
							Object.fromEntries(
								columns.map(([key, c]) => [
									c.name,
									sql`json_extract(value, ${`$.${key}`})`.as(c.name),
								]),
							),
						)
						.from(sql`json_each(${JSON.stringify(archivedRows)})`);
	const source =
		archiveSource === null
			? sql`tedi_call_costs`
			: sql`(${archiveSource.getSQL()})`;
	const snapshotField = (key: string) =>
		snapshotValue(db, document, undefined, key, true);
	const evidenceJson = postgres
		? sql`(jsonb_build_object('versionId',leaf.id,'pricingBasis',leaf.pricing_basis,'providerEstimatedCostMicros',leaf.provider_estimated_cost_micros,'basisFactsDigest',leaf.basis_facts_digest,'sourceSnapshotDigest',leaf.original_source_digest,'effectiveCostBasis','reviewed_provider_estimate','originalCostBasis',${snapshotField("costBasis")},'originalCostReason',${snapshotField("costReason")},'originalDataQuality',${snapshotField("dataQuality")},'originalEstimatedCostUsd',${snapshotField("estimatedCostUsd")}))::text`
		: sql`json_object('versionId',leaf.id,'pricingBasis',leaf.pricing_basis,'providerEstimatedCostMicros',leaf.provider_estimated_cost_micros,'basisFactsDigest',leaf.basis_facts_digest,'sourceSnapshotDigest',leaf.original_source_digest,'effectiveCostBasis','reviewed_provider_estimate','originalCostBasis',${snapshotField("costBasis")},'originalCostReason',${snapshotField("costReason")},'originalDataQuality',${snapshotField("dataQuality")},'originalEstimatedCostUsd',${snapshotField("estimatedCostUsd")})`;
	const query = sql`WITH leaf AS (SELECT version.* FROM billing_provider_cost_evidence_versions version WHERE NOT EXISTS
	(SELECT 1 FROM billing_provider_cost_evidence_versions child WHERE child.supersedes_evidence_version_id = version.id))
	SELECT ${original}, leaf.provider_estimated_cost_micros AS reviewed_cost_micros,
	CASE WHEN leaf.id IS NULL THEN NULL ELSE ${evidenceJson} END AS provider_cost_evidence, 0 AS source_retired
	FROM ${source} original LEFT JOIN leaf ON leaf.original_org_id = original.org_id AND leaf.source_call_id = original.id
	AND leaf.source_gateway_id = original.gateway_id AND leaf.gateway_log_id = original.gateway_log_id
	UNION ALL SELECT ${retired}, leaf.provider_estimated_cost_micros AS reviewed_cost_micros,
	${evidenceJson} AS provider_cost_evidence, 1 AS source_retired
	FROM leaf WHERE ${Number(archivedRows === undefined)} = 1
	AND NOT EXISTS (SELECT 1 FROM tedi_call_costs original WHERE original.id = leaf.source_call_id)`;
	return new Subquery(
		query,
		getColumns(tediCallCosts),
		"tedi_call_costs",
		false,
	);
}
export const reviewedCostMicros = sql<
	number | null
>`"tedi_call_costs"."reviewed_cost_micros"`;
export const providerCostEvidenceProjection = sql<
	string | null
>`"tedi_call_costs"."provider_cost_evidence"`;
export const sourceRetiredProjection = sql<number>`"tedi_call_costs"."source_retired"`;
export const effectiveCostUsd = sql<
	number | null
>`CASE WHEN ${reviewedCostMicros} IS NOT NULL THEN ${reviewedCostMicros} / 1000000.0 ELSE ${tediCallCosts.estimatedCostUsd} END`;
export const effectiveCostKnown = sql`(${reviewedCostMicros} IS NOT NULL OR (${tediCallCosts.dataQuality} = 'ok' AND ${tediCallCosts.costBasis} != 'unknown' AND ${tediCallCosts.estimatedCostUsd} IS NOT NULL AND ${tediCallCosts.estimatedCostUsd} >= 0))`;

export async function getProviderCostEvidenceSource(
	db: DbClient,
	organizationId: string,
	sourceCallId: string,
) {
	const tediCallCostsTable = coreTable(db, tediCallCosts);
	return (
		(
			await db
				.select()
				.from(tediCallCostsTable)
				.where(
					and(
						eq(tediCallCostsTable.orgId, organizationId),
						eq(tediCallCostsTable.id, sourceCallId),
					),
				)
				.limit(1)
		)[0] ?? null
	);
}
/** Raw persisted canonical bytes are compared again by the INSERT, never reserialized. */
export async function getProviderCostEvidenceApproval(
	db: DbClient,
	organizationId: string,
	proposalId: string,
	decisionId: string,
) {
	const proposals = coreTable(db, workApprovalProposals);
	const decisions = coreTable(db, workApprovalDecisions);
	const rows = await db
		.select({
			proposal: proposals,
			decision: decisions,
			rawProposal: sql<string>`CAST(${proposals.proposal} AS TEXT)`,
		})
		.from(proposals)
		.innerJoin(decisions, eq(decisions.proposalId, proposals.id))
		.where(
			and(
				eq(proposals.orgId, organizationId),
				eq(proposals.id, proposalId),
				eq(decisions.id, decisionId),
			),
		)
		.limit(1);
	return rows[0] ?? null;
}
export async function getProviderCostEvidenceAuthorityBundle(
	db: DbClient,
	organizationId: string,
	workId: string,
	attemptId: string | null,
) {
	const items = coreTable(db, workItems);
	const attemptsTable = coreTable(db, workAttempts);
	const requirementsTable = coreTable(db, workResourceRequirements);
	const admissionsTable = coreTable(db, workAdmissions);
	const reservationsTable = coreTable(db, workResourceReservations);
	const [work, attempts, requirements] = await Promise.all([
		db
			.select(workItemStoredColumns)
			.from(items)
			.where(and(eq(items.orgId, organizationId), eq(items.id, workId)))
			.limit(1),
		attemptId
			? db
					.select()
					.from(attemptsTable)
					.where(
						and(
							eq(attemptsTable.orgId, organizationId),
							eq(attemptsTable.workItemId, workId),
							eq(attemptsTable.id, attemptId),
						),
					)
					.limit(1)
			: [],
		db
			.select()
			.from(requirementsTable)
			.where(
				and(
					eq(requirementsTable.orgId, organizationId),
					eq(requirementsTable.workItemId, workId),
				),
			),
	]);
	const attempt = attempts[0] ?? null;
	const [admissions, resources] = attempt?.admissionId
		? await Promise.all([
				db
					.select()
					.from(admissionsTable)
					.where(
						and(
							eq(admissionsTable.orgId, organizationId),
							eq(admissionsTable.id, attempt.admissionId),
						),
					)
					.limit(1),
				db
					.select()
					.from(reservationsTable)
					.where(
						and(
							eq(reservationsTable.orgId, organizationId),
							eq(reservationsTable.admissionId, attempt.admissionId),
						),
					),
			])
		: [[], []];
	return {
		work: work[0] ?? null,
		attempt,
		admission: admissions[0] ?? null,
		requirements,
		resources,
	};
}
export async function getProviderCostEvidenceByIdempotency(
	db: DbClient,
	organizationId: string,
	idempotencyDigest: string,
) {
	const versions = coreTable(db, evidence);
	return (
		(
			await db
				.select()
				.from(versions)
				.where(
					and(
						eq(versions.originalOrgId, organizationId),
						eq(versions.idempotencyDigest, idempotencyDigest),
					),
				)
				.limit(1)
		)[0] ?? null
	);
}
export async function getProviderCostEvidenceCurrent(
	db: DbClient,
	organizationId: string,
	sourceCallId: string,
) {
	const versions = coreTable(db, evidence);
	return (
		(
			await db
				.select()
				.from(versions)
				.where(
					and(
						eq(versions.originalOrgId, organizationId),
						eq(versions.sourceCallId, sourceCallId),
						sql`NOT EXISTS (SELECT 1 FROM billing_provider_cost_evidence_versions child WHERE child.supersedes_evidence_version_id = ${versions.id})`,
					),
				)
				.limit(1)
		)[0] ?? null
	);
}
export async function getProviderCostEvidenceRelationships(
	db: DbClient,
	source: typeof tediCallCosts.$inferSelect,
) {
	const [execution, reservation, quarantine] = await Promise.all([
		source.executionId
			? getProviderExecutionsByIds(db, [source.executionId])
			: [],
		(() => {
			if (!source.billingReservationId) return [];
			const reservations = coreTable(db, billingUsageReservations);
			return db
				.select()
				.from(reservations)
				.where(eq(reservations.id, source.billingReservationId))
				.limit(1);
		})(),
		(async () => {
			const read = (store: DbClient) => {
				const quarantines = coreTable(store, billingUsageQuarantines);
				return store
					.select()
					.from(quarantines)
					.where(eq(quarantines.gatewayLogId, source.gatewayLogId))
					.limit(1);
			};
			const pages = await readLogStores(db, read);
			return pages ? mergeLogStoreRows(pages) : read(db);
		})(),
	]);
	return {
		executionSnapshot: execution[0] ?? null,
		reservationSnapshot: reservation[0] ?? null,
		quarantineSnapshot: quarantine[0] ?? null,
	};
}
export async function providerCostEvidenceIdentityDigest(
	originalOrgId: string,
	sourceGatewayId: string,
	gatewayLogId: string,
	sourceCallId: string,
) {
	const values = [originalOrgId, sourceGatewayId, gatewayLogId, sourceCallId];
	if (values.some((v) => typeof v !== "string" || !v.length))
		throw new Error("Missing original identity");
	const bytes = new TextEncoder().encode(
		JSON.stringify([
			"tedix.billing.provider-cost-evidence.original-source.v1",
			...values,
		]),
	);
	return Array.from(
		new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
		(v) => v.toString(16).padStart(2, "0"),
	).join("");
}
export interface AppendProviderCostEvidenceParams {
	row: NewProviderCostEvidenceRow;
	rawProposal: string;
	proposalVersion: number;
	authorityKey: string;
	designatedApproverType: "user" | "tedi";
	designatedApproverId: string;
	clientRecordId: string;
	externalSessionKey: string;
	requestDeadlineAt: string;
	/** Complete source and relationship rows read by this same database client. */
	source: typeof tediCallCosts.$inferSelect;
	executionSnapshot: Record<string, unknown> | null;
	reservationSnapshot: Record<string, unknown> | null;
	quarantineSnapshot: Record<string, unknown> | null;
}

/** One statement per record. All predicates execute at INSERT time on the same D1. */
export function buildAppendProviderCostEvidenceStatement(
	db: DbClient,
	p: AppendProviderCostEvidenceParams,
) {
	const columns = getColumns(evidence);
	const sourceColumns = getColumns(tediCallCosts);
	if (Object.keys(sourceColumns).some((key) => !Object.hasOwn(p.source, key)))
		throw new Error("Incomplete original source snapshot");
	const payload = JSON.stringify({
		row: p.row,
		source: p.source,
		execution: p.executionSnapshot,
		reservation: p.reservationSnapshot,
		quarantine: p.quarantineSnapshot,
		rawProposal: p.rawProposal,
		proposalVersion: p.proposalVersion,
		authorityKey: p.authorityKey,
		approverType: p.designatedApproverType,
		approverId: p.designatedApproverId,
		clientRecordId: p.clientRecordId,
		externalSessionKey: p.externalSessionKey,
		requestDeadlineAt: p.requestDeadlineAt,
	});
	const postgres = coreStore(db) === "postgres";
	const document = postgres ? sql`payload.value::jsonb` : sql`payload.value`;
	// Paths are generated solely from static schema property names. One JSON bind
	// avoids exceeding D1's 100-parameter limit while retaining every raw fence.
	const j = (path: string) => {
		if (!/^\$\.[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)*$/.test(path))
			throw new Error("Invalid internal snapshot path");
		if (!postgres)
			return sql`json_extract(payload.value, ${sql.raw(`'${path}'`)})`;
		return sql`(${document} #>> ${pgTextArray(path.slice(2).split("."))}::text[])`;
	};
	/** `j(path)` cast to a physical type, for typed columns and INSERT values. */
	const jCast = (path: string, type: string) =>
		postgres ? sql`(${j(path)})::${sql.raw(type)}` : j(path);
	const jColumn = (path: string, table: CoreTable, key: string) => {
		if (!postgres) return j(path);
		const type = pgCast(pgColumnType(db, table, key));
		return type ? sql`(${j(path)})::${sql.raw(type)}` : j(path);
	};
	/** SQLite `IS` is NULL-safe equality; Postgres spells it IS NOT DISTINCT FROM. */
	const nullSafeEq = (
		left: ReturnType<typeof sql>,
		right: ReturnType<typeof sql>,
	) =>
		postgres
			? sql`${left} IS NOT DISTINCT FROM ${right}`
			: sql`${left} IS ${right}`;
	const afterNow = (value: ReturnType<typeof sql>) =>
		postgres
			? sql`CASE WHEN pg_input_is_valid(${value}, 'timestamp with time zone') THEN CASE WHEN ${value} ~ '(Z|[+-][0-9]{2}:[0-9]{2})$' THEN ${value}::timestamptz ELSE ${value}::timestamp AT TIME ZONE 'UTC' END END > now()`
			: sql`julianday(${value}) > julianday('now')`;
	const relationship = (
		table:
			| typeof providerExecutionAttempts
			| typeof billingUsageReservations
			| typeof billingUsageQuarantines,
		alias: string,
		snapshot: string,
		idColumn: string,
		sourceColumn: string,
	) => {
		const fence = sql.join(
			Object.entries(getColumns(table)).map(([key, column]) =>
				nullSafeEq(
					sql`${sql.identifier(alias)}.${sql.identifier(column.name)}`,
					jColumn(`$.${snapshot}.${key}`, table, key),
				),
			),
			sql` AND `,
		);
		const absent =
			snapshot === "quarantine"
				? sql`NOT EXISTS (SELECT 1 FROM ${table} ${sql.identifier(alias)} WHERE ${sql.identifier(alias)}.${sql.identifier(idColumn)} = source.${sql.identifier(sourceColumn)})`
				: sql`source.${sql.identifier(sourceColumn)} IS NULL`;
		return sql`((${j(`$.${snapshot}`)} IS NULL AND ${absent}) OR EXISTS (SELECT 1 FROM ${table} ${sql.identifier(alias)} WHERE ${sql.identifier(alias)}.${sql.identifier(idColumn)} = source.${sql.identifier(sourceColumn)} AND ${fence}))`;
	};
	const sourceFence = sql.join(
		Object.entries(sourceColumns).map(([key, column]) =>
			nullSafeEq(
				sql`source.${sql.identifier(column.name)}`,
				jColumn(`$.source.${key}`, tediCallCosts, key),
			),
		),
		sql` AND `,
	);
	// Raw: one JSON-bound CTE feeds a conditional INSERT ... SELECT whose fences use
	// json_each and literal paths (D1's 100-parameter limit); Drizzle cannot build it.
	const names = sql.join(
		Object.values(columns).map((c) => sql.identifier(c.name)),
		sql`, `,
	);
	const values = sql.join(
		Object.keys(columns).map((key) => jColumn(`$.row.${key}`, evidence, key)),
		sql`, `,
	);
	const requiredAuthority = postgres
		? sql`jsonb_array_elements_text(work.required_authorities) AS required_authority(value)`
		: sql`json_each(work.required_authorities) required_authority`;
	const proposalMatch = postgres
		? sql`proposal.proposal = ${jCast("$.rawProposal", "jsonb")}`
		: sql`proposal.proposal = ${j("$.rawProposal")}`;
	return db.run(sql`WITH payload(value) AS (SELECT ${payload})
	INSERT INTO billing_provider_cost_evidence_versions (${names}) SELECT ${values} FROM payload
	WHERE ${j("$.row.createdByActorType")} = 'external_agent' AND ${afterNow(j("$.requestDeadlineAt"))} AND ${afterNow(j("$.row.financialManifestSnapshot.expiresAt"))} AND EXISTS (SELECT 1 FROM tedi_call_costs source WHERE ${sourceFence}
	AND source.org_id = ${j("$.row.originalOrgId")} AND source.id = ${j("$.row.sourceCallId")}
	AND source.gateway_id = ${j("$.row.sourceGatewayId")} AND source.gateway_log_id = ${j("$.row.gatewayLogId")}
	AND ${relationship(providerExecutionAttempts, "execution", "execution", "id", "provider_execution_id")}
	AND ${relationship(billingUsageReservations, "reservation", "reservation", "id", "billing_reservation_id")}
	AND ${relationship(billingUsageQuarantines, "quarantine", "quarantine", "gateway_log_id", "gateway_log_id")}
	AND (source.cost_basis = 'unknown' OR source.data_quality = 'quarantined_no_pricing')
	AND NOT EXISTS (SELECT 1 FROM billing_usage_charges charge WHERE charge.organization_id = source.org_id AND
	(charge.gateway_log_id = source.gateway_log_id OR charge.reservation_id = source.billing_reservation_id OR charge.provider_usage_id = source.id))
	AND NOT EXISTS (SELECT 1 FROM billing_provider_reconciliations reconciliation WHERE reconciliation.provider = source.provider
	AND reconciliation.provider_resource = coalesce(source.provider_resource, '') AND reconciliation.period_start <= source.snapshot_at
	AND reconciliation.period_end > source.snapshot_at AND reconciliation.status IN ('matched','approved')))
	AND EXISTS (SELECT 1 FROM work_items work
	JOIN work_approval_proposals proposal ON proposal.work_item_id = work.id AND proposal.org_id = work.org_id
	JOIN work_approval_decisions decision ON decision.proposal_id = proposal.id
	JOIN work_attempts attempt ON attempt.work_item_id = work.id AND attempt.org_id = work.org_id
	JOIN work_admissions admission ON admission.id = attempt.admission_id AND admission.work_item_id = work.id AND admission.org_id = work.org_id
	JOIN external_agent_principals principal ON principal.id = attempt.executor_id AND principal.organization_id = work.org_id
	JOIN external_agent_sessions session ON session.id = attempt.executor_session_id AND session.principal_id = principal.id AND session.organization_id = work.org_id
	JOIN external_agent_mcp_credentials credential ON credential.session_id = session.id AND credential.principal_id = principal.id AND credential.organization_id = work.org_id
	WHERE work.id = ${j("$.row.financialWorkId")} AND work.org_id = ${j("$.row.originalOrgId")} AND work.disposition = 'accepted'
	AND work.version = ${jColumn("$.row.financialWorkVersion", evidence, "financialWorkVersion")} AND work.admission_spec_revision = ${j("$.row.financialSpecRevision")}
	AND proposal.id = ${j("$.row.approvalProposalId")} AND proposal.work_item_version = work.version AND proposal.status = 'approved'
	AND proposal.version = ${jCast("$.proposalVersion", "bigint")} AND ${proposalMatch}
	AND proposal.action = 'billing.recordProviderCostEvidence' AND proposal.authority_key = ${j("$.authorityKey")}
	AND EXISTS (SELECT 1 FROM ${requiredAuthority} WHERE required_authority.value = proposal.authority_key)
	AND proposal.approver_type = ${j("$.approverType")} AND proposal.approver_id = ${j("$.approverId")}
	AND decision.id = ${j("$.row.approvalDecisionId")} AND decision.decision = 'approved'
	AND decision.resolved_proposal_version = proposal.version AND decision.decider_type = proposal.approver_type AND decision.decider_id = proposal.approver_id
	AND ${afterNow(sql`proposal.expires_at`)}
	AND attempt.id = ${j("$.row.attemptId")} AND attempt.admission_id = ${j("$.row.admissionId")}
	AND attempt.runtime_state = 'running' AND attempt.outcome IS NULL AND attempt.finished_at IS NULL AND ${afterNow(sql`attempt.expires_at`)}
	AND attempt.executor_type = 'external_agent' AND attempt.executor_id = ${j("$.row.createdByActorId")}
	AND attempt.executor_session_id = ${j("$.row.createdBySessionId")} AND attempt.external_session_key = ${j("$.externalSessionKey")}
	AND admission.decision = 'admitted' AND admission.work_item_version = work.version AND admission.admission_spec_revision = work.admission_spec_revision
	AND admission.executor_type = attempt.executor_type AND admission.executor_id = attempt.executor_id
	AND admission.executor_session_id = attempt.executor_session_id AND admission.external_session_key = attempt.external_session_key
	AND ${afterNow(sql`admission.expires_at`)} AND principal.status = 'active' AND session.status = 'active' AND session.ended_at IS NULL
	AND session.external_session_key = attempt.external_session_key AND credential.client_record_id = ${j("$.clientRecordId")}
	AND credential.status = 'active' AND credential.revoked_at IS NULL AND ${afterNow(sql`credential.expires_at`)}
	AND NOT EXISTS (SELECT 1 FROM work_resource_requirements required WHERE required.org_id = work.org_id AND required.work_item_id = work.id
	AND NOT EXISTS (SELECT 1 FROM work_resource_reservations reserved WHERE reserved.org_id = work.org_id AND reserved.work_item_id = work.id
	AND reserved.admission_id = admission.id AND reserved.resource_key = required.resource_key AND reserved.quantity = required.quantity
	AND reserved.state = 'active' AND ${afterNow(sql`reserved.expires_at`)})))
	AND NOT EXISTS (SELECT 1 FROM billing_provider_cost_evidence_versions old WHERE old.original_org_id = ${j("$.row.originalOrgId")}
	AND old.source_gateway_id = ${j("$.row.sourceGatewayId")} AND old.gateway_log_id = ${j("$.row.gatewayLogId")}
	AND old.source_call_id = ${j("$.row.sourceCallId")} AND old.supersedes_evidence_version_id IS NULL AND ${j("$.row.supersedesEvidenceVersionId")} IS NULL)
	AND (${j("$.row.supersedesEvidenceVersionId")} IS NULL OR EXISTS (SELECT 1 FROM billing_provider_cost_evidence_versions parent
	WHERE parent.id = ${j("$.row.supersedesEvidenceVersionId")} AND parent.original_org_id = ${j("$.row.originalOrgId")}
	AND parent.source_gateway_id = ${j("$.row.sourceGatewayId")} AND parent.gateway_log_id = ${j("$.row.gatewayLogId")}
	AND parent.source_call_id = ${j("$.row.sourceCallId")} AND parent.scope_digest = ${j("$.row.scopeDigest")}
	AND NOT EXISTS (SELECT 1 FROM billing_provider_cost_evidence_versions child WHERE child.supersedes_evidence_version_id = parent.id)))`);
}

/** Execute only preconstructed, fully validated records through the D1 batch owner. */
export function executeProviderCostEvidenceBatch(
	db: DbClient,
	statements: ReturnType<typeof buildAppendProviderCostEvidenceStatement>[],
) {
	if (statements.length < 1 || statements.length > 20)
		throw new Error("Evidence batch must contain 1..20 statements");
	const [first, ...rest] = statements;
	if (!first) throw new Error("Missing evidence statement");
	return db.batch([first, ...rest]);
}
