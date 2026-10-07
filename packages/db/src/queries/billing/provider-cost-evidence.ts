import { and, eq, getColumns, sql, Subquery } from "drizzle-orm";
import {
	ProviderCostEvidenceProjectionSchema,
	type ProviderCostEvidenceProjection,
} from "@tedix/api-contract/schemas/provider-cost-evidence";
import type { DbClient } from "../../client";
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
import { workItems, workAttempts } from "../../schema/work-items";

export type ProviderCostEvidenceRow = typeof evidence.$inferSelect;
export type NewProviderCostEvidenceRow = typeof evidence.$inferInsert;
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
export function effectiveCallCostsRelation() {
	const columns = Object.entries(getColumns(tediCallCosts));
	const original = sql.join(
		columns.map(
			([, c]) =>
				sql`original.${sql.identifier(c.name)} AS ${sql.identifier(c.name)}`,
		),
		sql`, `,
	);
	const retired = sql.join(
		columns.map(
			([key, c]) =>
				sql`json_extract(leaf.original_source_snapshot, ${sql.raw(`'$.${key}'`)}) AS ${sql.identifier(c.name)}`,
		),
		sql`, `,
	);
	const query = sql`WITH leaf AS (SELECT version.* FROM billing_provider_cost_evidence_versions version WHERE NOT EXISTS
	(SELECT 1 FROM billing_provider_cost_evidence_versions child WHERE child.supersedes_evidence_version_id = version.id))
	SELECT ${original}, leaf.provider_estimated_cost_micros AS reviewed_cost_micros,
	CASE WHEN leaf.id IS NULL THEN NULL ELSE json_object('versionId',leaf.id,'pricingBasis',leaf.pricing_basis,
	'providerEstimatedCostMicros',leaf.provider_estimated_cost_micros,'basisFactsDigest',leaf.basis_facts_digest,
	'sourceSnapshotDigest',leaf.original_source_digest,'effectiveCostBasis','reviewed_provider_estimate',
	'originalCostBasis',json_extract(leaf.original_source_snapshot,'$.costBasis'), 'originalCostReason',json_extract(leaf.original_source_snapshot,'$.costReason'),
	'originalDataQuality',json_extract(leaf.original_source_snapshot,'$.dataQuality'),'originalEstimatedCostUsd',json_extract(leaf.original_source_snapshot,'$.estimatedCostUsd')) END AS provider_cost_evidence, 0 AS source_retired
	FROM tedi_call_costs original LEFT JOIN leaf ON leaf.original_org_id = original.org_id AND leaf.source_call_id = original.id
	AND leaf.source_gateway_id = original.gateway_id AND leaf.gateway_log_id = original.gateway_log_id
	UNION ALL SELECT ${retired}, leaf.provider_estimated_cost_micros AS reviewed_cost_micros,
	json_object('versionId',leaf.id,'pricingBasis',leaf.pricing_basis,'providerEstimatedCostMicros',leaf.provider_estimated_cost_micros,
	'basisFactsDigest',leaf.basis_facts_digest,'sourceSnapshotDigest',leaf.original_source_digest,'effectiveCostBasis','reviewed_provider_estimate',
	'originalCostBasis',json_extract(leaf.original_source_snapshot,'$.costBasis'),'originalCostReason',json_extract(leaf.original_source_snapshot,'$.costReason'),
	'originalDataQuality',json_extract(leaf.original_source_snapshot,'$.dataQuality'),'originalEstimatedCostUsd',json_extract(leaf.original_source_snapshot,'$.estimatedCostUsd')) AS provider_cost_evidence, 1 AS source_retired
	FROM leaf WHERE NOT EXISTS (SELECT 1 FROM tedi_call_costs original WHERE original.id = leaf.source_call_id)`;
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
	return (
		(
			await db
				.select()
				.from(tediCallCosts)
				.where(
					and(
						eq(tediCallCosts.orgId, organizationId),
						eq(tediCallCosts.id, sourceCallId),
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
	const rows = await db
		.select({
			proposal: workApprovalProposals,
			decision: workApprovalDecisions,
			rawProposal: sql<string>`CAST(${workApprovalProposals.proposal} AS TEXT)`,
		})
		.from(workApprovalProposals)
		.innerJoin(
			workApprovalDecisions,
			eq(workApprovalDecisions.proposalId, workApprovalProposals.id),
		)
		.where(
			and(
				eq(workApprovalProposals.orgId, organizationId),
				eq(workApprovalProposals.id, proposalId),
				eq(workApprovalDecisions.id, decisionId),
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
	const [work, attempts, requirements] = await Promise.all([
		db
			.select()
			.from(workItems)
			.where(and(eq(workItems.orgId, organizationId), eq(workItems.id, workId)))
			.limit(1),
		attemptId
			? db
					.select()
					.from(workAttempts)
					.where(
						and(
							eq(workAttempts.orgId, organizationId),
							eq(workAttempts.workItemId, workId),
							eq(workAttempts.id, attemptId),
						),
					)
					.limit(1)
			: [],
		db
			.select()
			.from(workResourceRequirements)
			.where(
				and(
					eq(workResourceRequirements.orgId, organizationId),
					eq(workResourceRequirements.workItemId, workId),
				),
			),
	]);
	const attempt = attempts[0] ?? null;
	const [admissions, resources] = attempt?.admissionId
		? await Promise.all([
				db
					.select()
					.from(workAdmissions)
					.where(
						and(
							eq(workAdmissions.orgId, organizationId),
							eq(workAdmissions.id, attempt.admissionId),
						),
					)
					.limit(1),
				db
					.select()
					.from(workResourceReservations)
					.where(
						and(
							eq(workResourceReservations.orgId, organizationId),
							eq(workResourceReservations.admissionId, attempt.admissionId),
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
	return (
		(
			await db
				.select()
				.from(evidence)
				.where(
					and(
						eq(evidence.originalOrgId, organizationId),
						eq(evidence.idempotencyDigest, idempotencyDigest),
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
	return (
		(
			await db
				.select()
				.from(evidence)
				.where(
					and(
						eq(evidence.originalOrgId, organizationId),
						eq(evidence.sourceCallId, sourceCallId),
						sql`NOT EXISTS (SELECT 1 FROM billing_provider_cost_evidence_versions child WHERE child.supersedes_evidence_version_id = ${evidence.id})`,
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
			? db
					.select()
					.from(providerExecutionAttempts)
					.where(eq(providerExecutionAttempts.id, source.executionId))
					.limit(1)
			: [],
		source.billingReservationId
			? db
					.select()
					.from(billingUsageReservations)
					.where(eq(billingUsageReservations.id, source.billingReservationId))
					.limit(1)
			: [],
		db
			.select()
			.from(billingUsageQuarantines)
			.where(eq(billingUsageQuarantines.gatewayLogId, source.gatewayLogId))
			.limit(1),
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
	// Paths are generated solely from static schema property names. One JSON bind
	// avoids exceeding D1's 100-parameter limit while retaining every raw fence.
	const j = (path: string) => {
		if (!/^\$\.[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)*$/.test(path))
			throw new Error("Invalid internal snapshot path");
		return sql`json_extract(payload.value, ${sql.raw(`'${path}'`)})`;
	};
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
			Object.entries(getColumns(table)).map(
				([key, column]) =>
					sql`${sql.identifier(alias)}.${sql.identifier(column.name)} IS ${j(`$.${snapshot}.${key}`)}`,
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
		Object.entries(sourceColumns).map(
			([key, column]) =>
				sql`source.${sql.identifier(column.name)} IS ${j(`$.source.${key}`)}`,
		),
		sql` AND `,
	);
	const names = sql.join(
		Object.values(columns).map((c) => sql.identifier(c.name)),
		sql`, `,
	);
	const values = sql.join(
		Object.keys(columns).map((key) => j(`$.row.${key}`)),
		sql`, `,
	);
	return db.run(sql`WITH payload(value) AS (SELECT ${payload})
	INSERT INTO billing_provider_cost_evidence_versions (${names}) SELECT ${values} FROM payload
	WHERE ${j("$.row.createdByActorType")} = 'external_agent' AND julianday(${j("$.requestDeadlineAt")}) > julianday('now') AND julianday(${j("$.row.financialManifestSnapshot.expiresAt")}) > julianday('now') AND EXISTS (SELECT 1 FROM tedi_call_costs source WHERE ${sourceFence}
	AND source.org_id = ${j("$.row.originalOrgId")} AND source.id = ${j("$.row.sourceCallId")}
	AND source.gateway_id = ${j("$.row.sourceGatewayId")} AND source.gateway_log_id = ${j("$.row.gatewayLogId")}
	AND ${relationship(providerExecutionAttempts, "execution", "execution", "id", "provider_execution_id")}
	AND ${relationship(billingUsageReservations, "reservation", "reservation", "id", "billing_reservation_id")}
	AND ${relationship(billingUsageQuarantines, "quarantine", "quarantine", "gateway_log_id", "gateway_log_id")}
	AND (source.cost_basis = 'unknown' OR source.data_quality = 'quarantined_no_pricing')
	AND NOT EXISTS (SELECT 1 FROM billing_usage_charges charge WHERE charge.organization_id = source.org_id AND
	(charge.gateway_log_id = source.gateway_log_id OR charge.reservation_id = source.billing_reservation_id OR charge.provider_usage_id = source.id))
	AND NOT EXISTS (SELECT 1 FROM billing_credit_entries credit WHERE credit.organization_id = source.org_id AND
	(credit.source_ref IN (source.id, source.gateway_log_id, source.billing_reservation_id) OR EXISTS
	(SELECT 1 FROM billing_usage_charges charge WHERE charge.id = credit.usage_charge_id AND (charge.gateway_log_id = source.gateway_log_id OR charge.reservation_id = source.billing_reservation_id))))
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
	AND work.version = ${j("$.row.financialWorkVersion")} AND work.admission_spec_revision = ${j("$.row.financialSpecRevision")}
	AND proposal.id = ${j("$.row.approvalProposalId")} AND proposal.work_item_version = work.version AND proposal.status = 'approved'
	AND proposal.version = ${j("$.proposalVersion")} AND proposal.proposal = ${j("$.rawProposal")}
	AND proposal.action = 'billing.recordProviderCostEvidence' AND proposal.authority_key = ${j("$.authorityKey")}
	AND EXISTS (SELECT 1 FROM json_each(work.required_authorities) required_authority WHERE required_authority.value = proposal.authority_key)
	AND proposal.approver_type = ${j("$.approverType")} AND proposal.approver_id = ${j("$.approverId")}
	AND decision.id = ${j("$.row.approvalDecisionId")} AND decision.decision = 'approved'
	AND decision.resolved_proposal_version = proposal.version AND decision.decider_type = proposal.approver_type AND decision.decider_id = proposal.approver_id
	AND julianday(proposal.expires_at) > julianday('now')
	AND attempt.id = ${j("$.row.attemptId")} AND attempt.admission_id = ${j("$.row.admissionId")}
	AND attempt.runtime_state = 'running' AND attempt.outcome IS NULL AND attempt.finished_at IS NULL AND julianday(attempt.expires_at) > julianday('now')
	AND attempt.executor_type = 'external_agent' AND attempt.executor_id = ${j("$.row.createdByActorId")}
	AND attempt.executor_session_id = ${j("$.row.createdBySessionId")} AND attempt.external_session_key = ${j("$.externalSessionKey")}
	AND admission.decision = 'admitted' AND admission.work_item_version = work.version AND admission.admission_spec_revision = work.admission_spec_revision
	AND admission.executor_type = attempt.executor_type AND admission.executor_id = attempt.executor_id
	AND admission.executor_session_id = attempt.executor_session_id AND admission.external_session_key = attempt.external_session_key
	AND julianday(admission.expires_at) > julianday('now') AND principal.status = 'active' AND session.status = 'active' AND session.ended_at IS NULL
	AND session.external_session_key = attempt.external_session_key AND credential.client_record_id = ${j("$.clientRecordId")}
	AND credential.status = 'active' AND credential.revoked_at IS NULL AND julianday(credential.expires_at) > julianday('now')
	AND NOT EXISTS (SELECT 1 FROM work_resource_requirements required WHERE required.org_id = work.org_id AND required.work_item_id = work.id
	AND NOT EXISTS (SELECT 1 FROM work_resource_reservations reserved WHERE reserved.org_id = work.org_id AND reserved.work_item_id = work.id
	AND reserved.admission_id = admission.id AND reserved.resource_key = required.resource_key AND reserved.quantity = required.quantity
	AND reserved.state = 'active' AND julianday(reserved.expires_at) > julianday('now'))))
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
