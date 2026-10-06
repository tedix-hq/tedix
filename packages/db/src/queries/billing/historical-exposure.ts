/** UNKNOWN custody facts and explicit finite human permission; never allocation or historical settlement. */
import { sha256Hex } from "@tedix/worker-kit/crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import {
	billingAccounts,
	billingHistoricalDecisions,
	billingHistoricalExposures,
	billingPlanVersions,
} from "../../schema/billing";
import { organizationMembers } from "../../schema/organization-members";
import {
	HistoricalExposureSchema,
	HistoricalExposureInputSchema,
	FiniteExecutionAuthorizationSchema,
	FiniteExecutionRevocationSchema,
	type FiniteExecutionAuthorization,
	type FiniteExecutionRevocation,
	type HistoricalExposure,
	type HistoricalFreshDecision,
} from "@tedix/api-contract/schemas/billing";

export async function historicalRequestHash(input: unknown): Promise<string> {
	return sha256Hex(JSON.stringify(input));
}
export async function getHistoricalBillingMember(
	db: DbQueryClient,
	organizationId: string,
	subject: string,
) {
	const [row] = await db
		.select()
		.from(organizationMembers)
		.where(
			and(
				eq(organizationMembers.organizationId, organizationId),
				eq(organizationMembers.descopeUserId, subject),
				eq(organizationMembers.status, "active"),
			),
		)
		.limit(1);
	return row ?? null;
}
export async function getHistoricalFunding(
	db: DbQueryClient,
	organizationId: string,
) {
	const [account] = await db
		.select()
		.from(billingAccounts)
		.where(eq(billingAccounts.organizationId, organizationId))
		.limit(1);
	if (!account) return null;
	const [plan] = await db
		.select()
		.from(billingPlanVersions)
		.where(eq(billingPlanVersions.id, account.planVersionId))
		.limit(1);
	return plan ? { account, plan } : null;
}
function memberFence(org: string, subject: string, userId: string) {
	return sql`EXISTS (SELECT 1 FROM organization_members WHERE organization_id=${org} AND descope_user_id=${subject} AND user_id=${userId} AND status='active' AND role IN ('owner','admin'))`;
}
function custodyFence(org: string, tediId: string, objectName: string) {
	return sql`EXISTS (SELECT 1 FROM tedis WHERE id=${tediId} AND organization_id=${org} AND isolate_agent_id=${objectName})`;
}
export async function listHistoricalExposures(
	db: DbQueryClient,
	organizationId: string,
	tediId: string,
) {
	return db
		.select()
		.from(billingHistoricalExposures)
		.where(
			and(
				eq(billingHistoricalExposures.organizationId, organizationId),
				eq(billingHistoricalExposures.tediId, tediId),
			),
		)
		.orderBy(asc(billingHistoricalExposures.id));
}
export async function historicalExposureSet(
	db: DbQueryClient,
	organizationId: string,
	tediId: string,
) {
	const rows = await listHistoricalExposures(db, organizationId, tediId);
	return {
		rows,
		hash: await historicalRequestHash(rows.map((r) => [r.id, r.requestHash])),
		revision: rows.length,
	};
}
export async function latestHistoricalDecision(
	db: DbQueryClient,
	org: string,
	tediId: string,
) {
	const [row] = await db
		.select()
		.from(billingHistoricalDecisions)
		.where(
			and(
				eq(billingHistoricalDecisions.organizationId, org),
				eq(billingHistoricalDecisions.tediId, tediId),
			),
		)
		.orderBy(sql`${billingHistoricalDecisions.revision} DESC`)
		.limit(1);
	return row ?? null;
}
export async function recordHistoricalExposure(
	db: DbQueryClient,
	input: { operationId: string; payload: HistoricalExposure },
) {
	const p = HistoricalExposureSchema.parse(input.payload);
	// The physical object_id selects the archived leaf; object_name remains the
	// canonical ROOT name. Selected original identity/path live explicitly in JSON.
	// Membership and canonical root-name custody are checked in the INSERT itself.
	await db.run(sql`INSERT INTO billing_historical_exposures
 (id,organization_id,tedi_id,object_id,object_name,generation,snapshot_id,source_hash,operation_id,request_hash,exposure,payload,observed_by,observed_user_id,observed_at)
 SELECT ${p.id},${p.organizationId},${p.tediId},${p.objectId},${p.rootObjectName},${p.generation},${p.snapshotId},${p.sourceHash},${input.operationId},${p.requestHash},'UNKNOWN',${JSON.stringify(p)},${p.observedBy},${p.observedUserId},${p.observedAt}
 WHERE ${memberFence(p.organizationId, p.observedBy, p.observedUserId)} AND ${custodyFence(p.organizationId, p.tediId, p.rootObjectName)}
 ON CONFLICT DO NOTHING`);
	const [row] = await db
		.select()
		.from(billingHistoricalExposures)
		.where(
			and(
				eq(billingHistoricalExposures.organizationId, p.organizationId),
				eq(billingHistoricalExposures.tediId, p.tediId),
				eq(billingHistoricalExposures.operationId, input.operationId),
				eq(billingHistoricalExposures.requestHash, p.requestHash),
				eq(billingHistoricalExposures.objectId, p.objectId),
				eq(billingHistoricalExposures.generation, p.generation),
				eq(billingHistoricalExposures.snapshotId, p.snapshotId),
				eq(billingHistoricalExposures.sourceHash, p.sourceHash),
				sql`json_extract(${billingHistoricalExposures.payload},'$.rootObjectId')=${p.rootObjectId} AND json_extract(${billingHistoricalExposures.payload},'$.rootObjectName')=${p.rootObjectName} AND json_extract(${billingHistoricalExposures.payload},'$.className')=${p.className} AND json_extract(${billingHistoricalExposures.payload},'$.objectName')=${p.objectName} AND json_extract(${billingHistoricalExposures.payload},'$.targetPath')=json(${JSON.stringify(p.targetPath)})`,
				memberFence(p.organizationId, p.observedBy, p.observedUserId),
				custodyFence(p.organizationId, p.tediId, p.rootObjectName),
			),
		)
		.limit(1);
	return row ?? null;
}
export async function recordHistoricalDecision(
	db: DbQueryClient,
	p: HistoricalFreshDecision,
	objectName: string,
	set: {
		rows: Awaited<ReturnType<typeof listHistoricalExposures>>;
		hash: string;
	},
) {
	const i = p.input;
	const parsed = set.rows.map((row) =>
		HistoricalExposureSchema.safeParse(row.payload),
	);
	if (parsed.some((value) => !value.success)) return null;
	const exposures = parsed.map((value) => value.data!);
	const rootExposures = exposures.filter(
		(value) => value.objectId === value.rootObjectId,
	);
	if (
		set.rows.some(
			(row, index) =>
				row.organizationId !== p.organizationId ||
				row.tediId !== p.tediId ||
				row.objectName !== objectName ||
				exposures[index]!.rootObjectName !== objectName ||
				row.objectId !== exposures[index]!.objectId ||
				row.generation !== exposures[index]!.generation ||
				row.snapshotId !== exposures[index]!.snapshotId ||
				row.sourceHash !== exposures[index]!.sourceHash ||
				row.requestHash !== exposures[index]!.requestHash,
		)
	)
		return null;
	if (
		p.kind === "decision" &&
		"objectId" in i &&
		(rootExposures.length === 0 ||
			exposures.some((value) => value.rootObjectId !== i.objectId))
	)
		return null;
	const [prior] = await db
		.select()
		.from(billingHistoricalDecisions)
		.where(
			and(
				eq(billingHistoricalDecisions.organizationId, p.organizationId),
				eq(billingHistoricalDecisions.tediId, p.tediId),
				eq(billingHistoricalDecisions.operationId, i.operationId),
				memberFence(p.organizationId, p.recordedBy, p.recordedUserId),
				custodyFence(p.organizationId, p.tediId, objectName),
			),
		)
		.limit(1);
	if (prior) return prior.requestHash === p.requestHash ? prior : null;
	const members = JSON.stringify(
		set.rows.map((r) => ({
			id: r.id,
			hash: r.requestHash,
			payload: r.payload,
			objectId: r.objectId,
			generation: r.generation,
			snapshotId: r.snapshotId,
			sourceHash: r.sourceHash,
			objectName: r.objectName,
		})),
	);
	const fullSet = sql`(SELECT COUNT(*) FROM billing_historical_exposures WHERE organization_id=${p.organizationId} AND tedi_id=${p.tediId})=${set.rows.length}
 AND NOT EXISTS (SELECT 1 FROM billing_historical_exposures e WHERE e.organization_id=${p.organizationId} AND e.tedi_id=${p.tediId}
 AND NOT EXISTS (SELECT 1 FROM json_each(${members}) j WHERE json_extract(j.value,'$.id')=e.id AND json_extract(j.value,'$.hash')=e.request_hash AND json(json_extract(j.value,'$.payload'))=json(e.payload) AND json_extract(j.value,'$.objectId')=e.object_id AND json_extract(j.value,'$.generation')=e.generation AND json_extract(j.value,'$.snapshotId')=e.snapshot_id AND json_extract(j.value,'$.sourceHash')=e.source_hash AND json_extract(j.value,'$.objectName')=e.object_name))`;
	let operationFence;
	if (p.kind === "decision" && "funding" in i) {
		const f = i.funding;
		if (
			set.rows.length === 0 ||
			set.hash !== i.exposureSetHash ||
			rootExposures.some((r) => i.permittedGeneration <= r.generation) ||
			p.revision !== i.expectedRevision + 1 ||
			f.accountId !== p.organizationId ||
			Date.parse(i.expiresAt) <= Date.parse(p.recordedAt) ||
			Date.parse(i.expiresAt) > Date.parse(f.periodEnd)
		)
			return null;
		operationFence = sql`${fullSet} AND EXISTS (
  SELECT 1 FROM billing_accounts a JOIN billing_plan_versions v ON v.id=a.plan_version_id
  WHERE a.organization_id=${p.organizationId} AND a.status=${f.status} AND a.billing_mode=${f.billingMode}
  AND a.entitlement_version=${f.entitlementVersion} AND a.plan_version_id=${f.planVersionId} AND v.version=${f.planVersion}
  AND julianday(a.period_start)=julianday(${f.periodStart}) AND julianday(a.period_end)=julianday(${f.periodEnd}) AND a.stripe_environment IS ${f.stripeEnvironment}
  AND julianday(a.period_start)<=julianday(${p.recordedAt}) AND julianday(a.period_end)>julianday(${p.recordedAt})
  AND julianday(${i.expiresAt})<=julianday(a.period_end) AND julianday('now')<julianday(${i.expiresAt}) AND julianday('now')>=julianday(a.period_start) AND julianday('now')<julianday(a.period_end))`;
	} else if (
		p.kind === "revocation" &&
		"decisionId" in i &&
		p.decisionId === i.decisionId &&
		p.revision === i.expectedRevision + 1
	) {
		operationFence = sql`EXISTS (SELECT 1 FROM billing_historical_decisions original WHERE original.id=${p.decisionId} AND original.organization_id=${p.organizationId} AND original.tedi_id=${p.tediId} AND original.kind='decision' AND json_extract(original.payload,'$.authority')='records_only')
  AND NOT EXISTS (SELECT 1 FROM billing_historical_decisions r WHERE r.organization_id=${p.organizationId} AND r.tedi_id=${p.tediId} AND r.decision_id=${p.decisionId} AND r.kind='revocation')`;
	} else return null;
	await db.run(sql`INSERT INTO billing_historical_decisions (id,organization_id,tedi_id,revision,kind,decision_id,operation_id,request_hash,payload,recorded_by,recorded_user_id,recorded_at)
 SELECT ${p.id},${p.organizationId},${p.tediId},${p.revision},${p.kind},${p.decisionId},${i.operationId},${p.requestHash},${JSON.stringify(p)},${p.recordedBy},${p.recordedUserId},${p.recordedAt}
 WHERE ${memberFence(p.organizationId, p.recordedBy, p.recordedUserId)} AND ${custodyFence(p.organizationId, p.tediId, objectName)}
 AND COALESCE((SELECT MAX(revision) FROM billing_historical_decisions WHERE organization_id=${p.organizationId} AND tedi_id=${p.tediId}),0)=${i.expectedRevision}
 AND ${operationFence} ON CONFLICT DO NOTHING`);
	// An exact retry returns the ORIGINAL event, even if expired/revoked; never renews it.
	const [row] = await db
		.select()
		.from(billingHistoricalDecisions)
		.where(
			and(
				eq(billingHistoricalDecisions.organizationId, p.organizationId),
				eq(billingHistoricalDecisions.tediId, p.tediId),
				eq(billingHistoricalDecisions.operationId, i.operationId),
				eq(billingHistoricalDecisions.requestHash, p.requestHash),
				memberFence(p.organizationId, p.recordedBy, p.recordedUserId),
				custodyFence(p.organizationId, p.tediId, objectName),
			),
		)
		.limit(1);
	return row ?? null;
}

export async function getHistoricalDecisionOperation(
	db: DbQueryClient,
	organizationId: string,
	tediId: string,
	operationId: string,
) {
	const [row] = await db
		.select()
		.from(billingHistoricalDecisions)
		.where(
			and(
				eq(billingHistoricalDecisions.organizationId, organizationId),
				eq(billingHistoricalDecisions.tediId, tediId),
				eq(billingHistoricalDecisions.operationId, operationId),
			),
		)
		.limit(1);
	return row ?? null;
}

/** Full fixed recorded-row proof. No original name is replaced by current custody. */
function finiteExposureFence(
	p: Pick<
		FiniteExecutionAuthorization,
		"organizationId" | "tediId" | "exposures" | "exposureOperations"
	>,
) {
	const facts = JSON.stringify(
		p.exposures.map((e, i) => ({
			exposure: e,
			operationId: p.exposureOperations[i]!.operationId,
		})),
	);
	return sql`(SELECT COUNT(*) FROM billing_historical_exposures WHERE organization_id=${p.organizationId} AND tedi_id=${p.tediId})=${p.exposures.length}
 AND NOT EXISTS (SELECT 1 FROM billing_historical_exposures e WHERE e.organization_id=${p.organizationId} AND e.tedi_id=${p.tediId}
 AND NOT EXISTS (SELECT 1 FROM json_each(${facts}) j WHERE json_extract(j.value,'$.exposure.id')=e.id
 AND json(json_extract(j.value,'$.exposure'))=json(e.payload)
 AND json_extract(j.value,'$.operationId')=e.operation_id
 AND json_extract(j.value,'$.exposure.rootObjectName')=e.object_name
 AND json_extract(j.value,'$.exposure.objectId')=e.object_id
 AND json_extract(j.value,'$.exposure.generation')=e.generation
 AND json_extract(j.value,'$.exposure.snapshotId')=e.snapshot_id
 AND json_extract(j.value,'$.exposure.sourceHash')=e.source_hash
 AND json_extract(j.value,'$.exposure.requestHash')=e.request_hash
 AND json_extract(j.value,'$.exposure.observedBy')=e.observed_by
 AND json_extract(j.value,'$.exposure.observedUserId')=e.observed_user_id
 AND json_extract(j.value,'$.exposure.observedAt')=e.observed_at AND e.exposure='UNKNOWN'))`;
}
function finiteFundingFence(p: FiniteExecutionAuthorization, live: boolean) {
	const f = p.input.funding;
	return sql`EXISTS (SELECT 1 FROM billing_accounts a JOIN billing_plan_versions v ON v.id=a.plan_version_id
 WHERE a.organization_id=${p.organizationId} AND a.status=${f.status} AND a.billing_mode=${f.billingMode}
 AND a.entitlement_version=${f.entitlementVersion} AND a.plan_version_id=${f.planVersionId} AND v.version=${f.planVersion}
 AND julianday(a.period_start)=julianday(${f.periodStart}) AND julianday(a.period_end)=julianday(${f.periodEnd})
 AND a.stripe_environment IS ${f.stripeEnvironment} AND julianday('now')>=julianday(a.period_start) AND julianday('now')<julianday(a.period_end)
 AND julianday(${p.recordedAt})>=julianday(a.period_start) AND julianday(${p.recordedAt})<julianday(a.period_end)
 AND julianday(${p.input.expiresAt})<=julianday(a.period_end)
 AND (${live ? 1 : 0}=0 OR julianday('now')<julianday(${p.input.expiresAt})))`;
}
/** Every scalar driving CAS, revocation or identity must agree with immutable JSON. */
function finiteEventRowFence(
	p: FiniteExecutionAuthorization | FiniteExecutionRevocation,
	alias?: "a",
) {
	const col = (name: string) =>
		sql.raw(`${alias ?? "billing_historical_decisions"}.${name}`);
	return sql`${col("id")}=${p.id} AND ${col("organization_id")}=${p.organizationId} AND ${col("tedi_id")}=${p.tediId}
 AND ${col("revision")}=${p.revision} AND ${col("kind")}=${p.kind} AND ${col("decision_id")} IS ${p.decisionId}
 AND ${col("operation_id")}=${p.input.operationId} AND ${col("request_hash")}=${p.requestHash}
 AND ${col("recorded_by")}=${p.recordedBy} AND ${col("recorded_user_id")}=${p.recordedUserId} AND ${col("recorded_at")}=${p.recordedAt}
 AND json(${col("payload")})=json(${JSON.stringify(p)})`;
}
/** Corrupt event projections must never hide supersession/revocation or redefine revision CAS. */
function finiteLedgerConsistencyFence(org: string, tedi: string) {
	return sql`NOT EXISTS (SELECT 1 FROM billing_historical_decisions h
 WHERE ((h.organization_id=${org} AND h.tedi_id=${tedi})
 OR CASE WHEN json_valid(h.payload)=1 THEN (json_extract(h.payload,'$.organizationId')=${org} AND json_extract(h.payload,'$.tediId')=${tedi}) ELSE 0 END)
 AND CASE WHEN json_valid(h.payload)=0 THEN 1
 WHEN (json_extract(h.payload,'$.authority')='finite_execution_permit' OR json_extract(h.payload,'$.input.kind') IN ('authorize_fresh_execution','revoke_fresh_execution')) THEN
 CASE WHEN json_extract(h.payload,'$.authority')='finite_execution_permit' AND h.id IS json_extract(h.payload,'$.id')
 AND h.organization_id IS json_extract(h.payload,'$.organizationId') AND h.tedi_id IS json_extract(h.payload,'$.tediId')
 AND json_type(h.payload,'$.revision')='integer' AND h.revision IS json_extract(h.payload,'$.revision')
 AND json_type(h.payload,'$.input.expectedRevision')='integer' AND h.revision=json_extract(h.payload,'$.input.expectedRevision')+1
 AND h.kind IS json_extract(h.payload,'$.kind') AND h.decision_id IS json_extract(h.payload,'$.decisionId')
 AND h.operation_id IS json_extract(h.payload,'$.input.operationId') AND h.request_hash IS json_extract(h.payload,'$.requestHash')
 AND h.recorded_by IS json_extract(h.payload,'$.recordedBy') AND h.recorded_user_id IS json_extract(h.payload,'$.recordedUserId')
 AND h.recorded_at IS json_extract(h.payload,'$.recordedAt')
 AND ((h.kind='decision' AND json_type(h.payload,'$.input.freshRootName')='text' AND length(json_extract(h.payload,'$.input.freshRootName'))>0 AND json_type(h.payload,'$.decisionId')='null' AND json_extract(h.payload,'$.input.kind')='authorize_fresh_execution')
 OR (h.kind='revocation' AND json_type(h.payload,'$.freshRootName')='text' AND length(json_extract(h.payload,'$.freshRootName'))>0 AND json_type(h.payload,'$.decisionId')='text' AND h.decision_id IS json_extract(h.payload,'$.input.authorizationId') AND json_extract(h.payload,'$.input.kind')='revoke_fresh_execution'))
 THEN 0 ELSE 1 END ELSE 0 END=1)`;
}
/** Exact readback within unchanged custody/funding is evidence only, even expired/revoked; never renewal. */
export async function readFiniteExecutionAuthorizationForHuman(
	db: DbQueryClient,
	p: FiniteExecutionAuthorization,
) {
	p = FiniteExecutionAuthorizationSchema.parse(p);
	if (
		p.requestHash !==
			(await historicalRequestHash([
				p.organizationId,
				p.recordedBy,
				p.recordedUserId,
				p.input,
			])) ||
		p.input.exposureSetHash !==
			(await historicalRequestHash(
				p.exposures.map((e) => [e.id, e.requestHash]),
			))
	)
		return null;
	const [row] = await db
		.select()
		.from(billingHistoricalDecisions)
		.where(
			and(
				finiteEventRowFence(p),
				memberFence(p.organizationId, p.recordedBy, p.recordedUserId),
				custodyFence(p.organizationId, p.tediId, p.input.freshRootName),
				finiteExposureFence(p),
				finiteFundingFence(p, false),
			),
		)
		.limit(1);
	return row ?? null;
}
export async function recordFiniteExecutionAuthorization(
	db: DbQueryClient,
	p: FiniteExecutionAuthorization,
) {
	p = FiniteExecutionAuthorizationSchema.parse(p);
	if (
		p.requestHash !==
			(await historicalRequestHash([
				p.organizationId,
				p.recordedBy,
				p.recordedUserId,
				p.input,
			])) ||
		p.input.funding.accountId !== p.organizationId ||
		p.revision !== p.input.expectedRevision + 1 ||
		p.input.exposureSetHash !==
			(await historicalRequestHash(
				p.exposures.map((e) => [e.id, e.requestHash]),
			))
	)
		return null;
	const prior = await getHistoricalDecisionOperation(
		db,
		p.organizationId,
		p.tediId,
		p.input.operationId,
	);
	if (prior) {
		const parsed = FiniteExecutionAuthorizationSchema.safeParse(prior.payload);
		return parsed.success && prior.requestHash === p.requestHash
			? readFiniteExecutionAuthorizationForHuman(db, parsed.data)
			: null;
	}
	await db.run(sql`INSERT INTO billing_historical_decisions (id,organization_id,tedi_id,revision,kind,decision_id,operation_id,request_hash,payload,recorded_by,recorded_user_id,recorded_at)
 SELECT ${p.id},${p.organizationId},${p.tediId},${p.revision},'decision',NULL,${p.input.operationId},${p.requestHash},${JSON.stringify(p)},${p.recordedBy},${p.recordedUserId},${p.recordedAt}
 WHERE ${memberFence(p.organizationId, p.recordedBy, p.recordedUserId)} AND ${custodyFence(p.organizationId, p.tediId, p.input.freshRootName)}
 AND ${finiteLedgerConsistencyFence(p.organizationId, p.tediId)}
 AND COALESCE((SELECT MAX(revision) FROM billing_historical_decisions WHERE organization_id=${p.organizationId} AND tedi_id=${p.tediId}),0)=${p.input.expectedRevision}
 AND ${finiteExposureFence(p)} AND ${finiteFundingFence(p, true)} ON CONFLICT DO NOTHING`);
	return readFiniteExecutionAuthorizationForHuman(db, p);
}
export async function recordFiniteExecutionRevocation(
	db: DbQueryClient,
	p: FiniteExecutionRevocation,
) {
	p = FiniteExecutionRevocationSchema.parse(p);
	if (
		p.revision !== p.input.expectedRevision + 1 ||
		p.requestHash !==
			(await historicalRequestHash([
				p.organizationId,
				p.recordedBy,
				p.recordedUserId,
				p.input,
			]))
	)
		return null;
	const original = await db
		.select()
		.from(billingHistoricalDecisions)
		.where(
			and(
				eq(billingHistoricalDecisions.id, p.decisionId),
				eq(billingHistoricalDecisions.organizationId, p.organizationId),
				eq(billingHistoricalDecisions.tediId, p.tediId),
			),
		)
		.limit(1);
	const grant = FiniteExecutionAuthorizationSchema.safeParse(
		original[0]?.payload,
	);
	if (
		!grant.success ||
		grant.data.input.freshRootName !== p.freshRootName ||
		grant.data.input.freshRootId !== p.freshRootId
	)
		return null;
	const prior = await getHistoricalDecisionOperation(
		db,
		p.organizationId,
		p.tediId,
		p.input.operationId,
	);
	let retained = p;
	if (prior) {
		const parsed = FiniteExecutionRevocationSchema.safeParse(prior.payload);
		if (
			!parsed.success ||
			prior.requestHash !== p.requestHash ||
			parsed.data.recordedBy !== p.recordedBy ||
			parsed.data.recordedUserId !== p.recordedUserId ||
			parsed.data.freshRootName !== p.freshRootName ||
			parsed.data.freshRootId !== p.freshRootId ||
			JSON.stringify(parsed.data.input) !== JSON.stringify(p.input)
		)
			return null;
		retained = parsed.data;
	}
	// Revocation remains possible after funding/permit expiry; it allocates nothing.
	if (!prior)
		await db.run(sql`INSERT INTO billing_historical_decisions (id,organization_id,tedi_id,revision,kind,decision_id,operation_id,request_hash,payload,recorded_by,recorded_user_id,recorded_at)
 SELECT ${p.id},${p.organizationId},${p.tediId},${p.revision},'revocation',${p.decisionId},${p.input.operationId},${p.requestHash},${JSON.stringify(p)},${p.recordedBy},${p.recordedUserId},${p.recordedAt}
 WHERE ${memberFence(p.organizationId, p.recordedBy, p.recordedUserId)} AND ${custodyFence(p.organizationId, p.tediId, p.freshRootName)}
 AND ${finiteLedgerConsistencyFence(p.organizationId, p.tediId)}
 AND COALESCE((SELECT MAX(revision) FROM billing_historical_decisions WHERE organization_id=${p.organizationId} AND tedi_id=${p.tediId}),0)=${p.input.expectedRevision}
 AND EXISTS (SELECT 1 FROM billing_historical_decisions WHERE ${finiteEventRowFence(grant.data)})
 AND NOT EXISTS (SELECT 1 FROM billing_historical_decisions WHERE organization_id=${p.organizationId} AND tedi_id=${p.tediId} AND kind='revocation' AND decision_id=${p.decisionId}) ON CONFLICT DO NOTHING`);
	const [row] = await db
		.select()
		.from(billingHistoricalDecisions)
		.where(
			and(
				finiteEventRowFence(retained),
				sql`EXISTS (SELECT 1 FROM billing_historical_decisions a WHERE ${finiteEventRowFence(grant.data, "a")})`,
				memberFence(p.organizationId, p.recordedBy, p.recordedUserId),
				custodyFence(p.organizationId, p.tediId, p.freshRootName),
			),
		)
		.limit(1);
	return row && FiniteExecutionRevocationSchema.safeParse(row.payload).success
		? row
		: null;
}
/** Owning policy predicate for later atomic admission; B must also verify genuine accepted origin and ordinary funding. A does not invoke provider admission. */
export async function finiteExecutionEligibilityPredicate(
	p: FiniteExecutionAuthorization,
	origin: {
		rootObjectId: string;
		rootObjectName: string;
		rootGeneration: number;
		objectId: string;
		className: string;
		generation: number;
		settlementMode: string;
		sendBefore: string;
	},
) {
	p = FiniteExecutionAuthorizationSchema.parse(p);
	if (
		p.requestHash !==
			(await historicalRequestHash([
				p.organizationId,
				p.recordedBy,
				p.recordedUserId,
				p.input,
			])) ||
		p.input.exposureSetHash !==
			(await historicalRequestHash(
				p.exposures.map((e) => [e.id, e.requestHash]),
			))
	)
		return sql`0=1`;
	const root = origin.className === "AgentTediDO";
	const scope = root
		? origin.objectId === p.input.freshRootId &&
			origin.generation === p.input.executionGeneration
		: origin.objectId !== p.input.freshRootId &&
			p.input.leafScopes.some(
				(s) =>
					s.className === origin.className &&
					s.generations.includes(origin.generation),
			);
	const local =
		scope &&
		origin.rootObjectId === p.input.freshRootId &&
		origin.rootObjectName === p.input.freshRootName &&
		origin.rootGeneration === p.input.executionGeneration &&
		origin.settlementMode === p.input.funding.settlementMode;
	return sql`${local ? 1 : 0}=1 AND ${finiteLedgerConsistencyFence(p.organizationId, p.tediId)} AND ${custodyFence(p.organizationId, p.tediId, p.input.freshRootName)} AND ${finiteExposureFence(p)} AND ${finiteFundingFence(p, true)}
 AND ${memberFence(p.organizationId, p.recordedBy, p.recordedUserId)} AND EXISTS (SELECT 1 FROM billing_historical_decisions a WHERE ${finiteEventRowFence(p, "a")})
 AND NOT EXISTS (SELECT 1 FROM billing_historical_decisions r WHERE r.organization_id=${p.organizationId} AND r.tedi_id=${p.tediId} AND r.kind='revocation' AND r.decision_id=${p.id})
 AND NOT EXISTS (SELECT 1 FROM billing_historical_decisions a WHERE a.organization_id=${p.organizationId} AND a.tedi_id=${p.tediId} AND a.kind='decision' AND a.revision>${p.revision} AND json_extract(a.payload,'$.authority')='finite_execution_permit' AND json_extract(a.payload,'$.input.freshRootName')=${p.input.freshRootName})
 AND julianday(${origin.sendBefore})>julianday('now') AND julianday(${origin.sendBefore})<=julianday(${p.input.expiresAt})
 AND julianday(${origin.sendBefore})<=julianday('now')+${p.input.maxSendDurationSeconds}/86400.0`;
}

export async function getFiniteExecutionAuthorization(
	db: DbQueryClient,
	org: string,
	tediId: string,
	id: string,
) {
	const [row] = await db
		.select()
		.from(billingHistoricalDecisions)
		.where(
			and(
				eq(billingHistoricalDecisions.id, id),
				eq(billingHistoricalDecisions.organizationId, org),
				eq(billingHistoricalDecisions.tediId, tediId),
				eq(billingHistoricalDecisions.kind, "decision"),
			),
		)
		.limit(1);
	const parsed = FiniteExecutionAuthorizationSchema.safeParse(row?.payload);
	if (
		!parsed.success ||
		parsed.data.requestHash !==
			(await historicalRequestHash([
				parsed.data.organizationId,
				parsed.data.recordedBy,
				parsed.data.recordedUserId,
				parsed.data.input,
			]))
	)
		return null;
	const [verified] = await db
		.select()
		.from(billingHistoricalDecisions)
		.where(finiteEventRowFence(parsed.data))
		.limit(1);
	return verified ?? null;
}

/** Sticky selection follows canonical NAME; physical identity is asserted or retained, never SQL-derived. */
export function nativeExecutionRequiresFinitePermitSql(
	origin: import("@tedix/api-contract/schemas/provider-execution").ProviderExecutionOrigin,
	verifiedCurrentRoot = false,
) {
	const org = origin.root.owner.orgId,
		tedi = origin.root.owner.tediId,
		name = origin.root.objectName;
	return sql`(${origin.root.generation > 0 || origin.selected.generation > 0 ? 1 : 0}=1
 OR EXISTS (SELECT 1 FROM billing_historical_decisions d WHERE d.organization_id=${org} AND d.tedi_id=${tedi}
 AND CASE WHEN json_valid(d.payload)=1 THEN
 (json_extract(d.payload,'$.authority')='finite_execution_permit' OR json_extract(d.payload,'$.input.kind') IN ('authorize_fresh_execution','revoke_fresh_execution'))
 AND (json_extract(d.payload,'$.input.freshRootName')=${name} OR json_extract(d.payload,'$.freshRootName')=${name}) ELSE 0 END)
 OR (${verifiedCurrentRoot ? 1 : 0}=0 AND EXISTS (SELECT 1 FROM billing_historical_exposures e WHERE e.organization_id=${org} AND e.tedi_id=${tedi}
 AND CASE WHEN json_valid(e.payload)=1 THEN json_extract(e.payload,'$.className')='AgentTediDO' AND json_array_length(e.payload,'$.targetPath')=0 ELSE 1 END)))`;
}
/** SQL-time enforcement only; the assertion's genuine local capture is a separate caller obligation. */
export async function nativeExecutionEligibilityPredicate(
	db: DbQueryClient,
	origin: import("@tedix/api-contract/schemas/provider-execution").ProviderExecutionOrigin,
	authorization: FiniteExecutionAuthorization | null,
	window: { authorizedAt: string; sendBefore: string; settlementMode: string },
) {
	const { ProviderExecutionOriginSchema } =
		await import("@tedix/api-contract/schemas/provider-execution");
	origin = ProviderExecutionOriginSchema.parse(origin);
	const org = origin.root.owner.orgId,
		tedi = origin.root.owner.tediId;
	const canonical = custodyFence(org, tedi, origin.root.objectName);
	const integrity = sql`${finiteLedgerConsistencyFence(org, tedi)} AND NOT EXISTS (
 SELECT 1 FROM billing_historical_exposures e WHERE CASE WHEN json_valid(e.payload)=1 THEN
 json_extract(e.payload,'$.organizationId')=${org} AND json_extract(e.payload,'$.tediId')=${tedi}
 AND (e.organization_id IS NOT ${org} OR e.tedi_id IS NOT ${tedi}) ELSE 0 END)`;
	// Verify original input digests and freeze every scalar/payload before allowing a root exemption.
	const rows = await listHistoricalExposures(db, org, tedi);
	const verified: HistoricalExposure[] = [];
	for (const row of rows) {
		const parsed = HistoricalExposureSchema.safeParse(row.payload);
		if (
			!parsed.success ||
			parsed.data.organizationId !== org ||
			parsed.data.tediId !== tedi
		)
			return sql`0=1`;
		const e = parsed.data;
		const originalInput = HistoricalExposureInputSchema.parse({
			tediId: tedi,
			operationId: row.operationId,
			rootObjectId: e.rootObjectId,
			objectId: e.objectId,
			targetPath: e.targetPath,
			expectedGeneration: e.generation,
			snapshotId: e.snapshotId,
			sourceHash: e.sourceHash,
		});
		if (
			e.requestHash !==
			(await historicalRequestHash([
				org,
				e.observedBy,
				e.observedUserId,
				originalInput,
			]))
		)
			return sql`0=1`;
		verified.push(e);
	}
	const exposures = finiteExposureFence({
		organizationId: org,
		tediId: tedi,
		exposures: verified,
		exposureOperations: rows.map((r) => ({
			id: r.id,
			operationId: r.operationId,
		})),
	});
	const currentRoot = verified.some(
		(e) =>
			e.className === "AgentTediDO" &&
			e.targetPath.length === 0 &&
			e.rootObjectName === origin.root.objectName &&
			e.rootObjectId === origin.root.owner.objectId,
	);
	if (!authorization)
		return sql`${origin.kind === "unselected_native" ? 1 : 0}=1 AND ${canonical} AND ${integrity} AND ${exposures}
 AND NOT ${nativeExecutionRequiresFinitePermitSql(origin, currentRoot)} AND julianday(${window.sendBefore})>julianday('now')`;
	authorization = FiniteExecutionAuthorizationSchema.parse(authorization);
	const duration =
		Date.parse(window.sendBefore) - Date.parse(window.authorizedAt);
	const valid =
		origin.kind === "accepted_native" &&
		authorization.organizationId === org &&
		authorization.tediId === tedi &&
		Number.isFinite(duration) &&
		duration > 0 &&
		duration <= authorization.input.maxSendDurationSeconds * 1000 &&
		Date.parse(window.sendBefore) <=
			Date.parse(authorization.input.expiresAt) &&
		Date.parse(window.sendBefore) <=
			Date.parse(authorization.input.funding.periodEnd);
	const finite = await finiteExecutionEligibilityPredicate(authorization, {
		rootObjectId: origin.root.owner.objectId,
		rootObjectName: origin.root.objectName,
		rootGeneration: origin.root.generation,
		objectId: origin.selected.owner.objectId,
		className: origin.selected.className,
		generation: origin.selected.generation,
		settlementMode: window.settlementMode,
		sendBefore: window.sendBefore,
	});
	return sql`${valid ? 1 : 0}=1 AND ${canonical} AND ${integrity} AND ${exposures} AND ${finite}`;
}
