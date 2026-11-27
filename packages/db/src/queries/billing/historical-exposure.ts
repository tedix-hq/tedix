/** UNKNOWN custody facts and explicit finite human permission; never allocation or historical settlement. */
import { sha256Hex } from "@tedix/worker-kit/crypto";
import { and, asc, eq, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { coreTable } from "../../core-store/client";
import {
	coreStore,
	jsonParameter,
	jsonRead,
	jsonType,
	pgTextArray,
} from "../../core-store/dialect";
import {
	billingAccounts as schemaBillingAccounts,
	billingHistoricalDecisions as schemaBillingHistoricalDecisions,
	billingHistoricalExposures as schemaBillingHistoricalExposures,
	billingPlanVersions as schemaBillingPlanVersions,
} from "../../schema/billing";
import { organizationMembers as schemaOrganizationMembers } from "../../schema/organization-members";
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

const postgres = (db: object) => coreStore(db) === "postgres";
/** julianday() instant: Postgres compares tz-normalized timestamptz values. */
function instant(db: object, value: string | number | SQLWrapper): SQL {
	const v = typeof value === "object" ? value : sql`${value}`;
	return postgres(db)
		? sql`CASE WHEN pg_input_is_valid(${v}, 'timestamp with time zone') THEN CASE WHEN ${v} ~ '(Z|[+-][0-9]{2}:[0-9]{2})$' THEN ${v}::timestamptz ELSE ${v}::timestamp AT TIME ZONE 'UTC' END END`
		: sql`julianday(${v})`;
}
function nowInstant(db: object): SQL {
	return postgres(db) ? sql`now()` : sql`julianday('now')`;
}
/** julianday('now')+seconds/86400 on D1; now() + seconds on Postgres. */
function nowPlusSeconds(db: object, seconds: number): SQL {
	return postgres(db)
		? sql`now() + ${seconds}::float8 * interval '1 second'`
		: sql`julianday('now')+${seconds}/86400.0`;
}
/** SQLite `IS` null-safe equality; Postgres spells it IS NOT DISTINCT FROM. */
function isSame(db: object, left: SQLWrapper, right: SQLWrapper): SQL {
	return postgres(db)
		? sql`${left} IS NOT DISTINCT FROM ${right}`
		: sql`${left} IS ${right}`;
}
/** SQLite `IS NOT` null-safe inequality; Postgres spells it IS DISTINCT FROM. */
function isDifferent(db: object, left: SQLWrapper, right: SQLWrapper): SQL {
	return postgres(db)
		? sql`${left} IS DISTINCT FROM ${right}`
		: sql`${left} IS NOT ${right}`;
}
/** json_extract text on D1; #>> text on Postgres (NULL for absent and JSON null). */
function jget(
	db: object,
	doc: SQLWrapper,
	path: readonly string[],
	kind: "text" | "number" | "json" = "text",
): SQL {
	return jsonRead(db, doc, path, kind);
}
/** json_type normalized to Postgres jsonb_typeof vocabulary on both stores. */
function jtype(db: object, doc: SQLWrapper, path: readonly string[]): SQL {
	return jsonType(db, doc, path);
}
/** SQLite json_type 'integer' excludes reals; Postgres jsonb keeps the literal text. */
function jinteger(db: object, doc: SQLWrapper, path: readonly string[]): SQL {
	if (!postgres(db))
		return sql`json_type(${doc}, ${`$.${path.join(".")}`}) = 'integer'`;
	return sql`(jsonb_typeof(${doc} #> ${pgTextArray(path)}::text[]) = 'number' AND (${doc} #>> ${pgTextArray(path)}::text[]) ~ '^-?[0-9]+$')`;
}
/** json_valid: Postgres payload columns are jsonb and always valid. */
function jvalid(db: object, doc: SQLWrapper): SQL {
	return postgres(db)
		? sql`pg_input_is_valid(${doc}::text, 'jsonb')`
		: sql`json_valid(${doc})`;
}
/** json(<doc|doc#path>) = json(bound): canonical JSON equality on both stores. */
function jeq(
	db: object,
	doc: SQLWrapper,
	path: readonly string[] | null,
	right: unknown,
): SQL {
	const left = path ? jget(db, doc, path, "json") : doc;
	return postgres(db)
		? sql`${left} = ${jsonParameter(db, right)}`
		: sql`json(${left}) = json(${JSON.stringify(right)})`;
}

export async function getHistoricalBillingMember(
	db: DbQueryClient,
	organizationId: string,
	subject: string,
) {
	const members = coreTable(db, schemaOrganizationMembers);
	const [row] = await db
		.select()
		.from(members)
		.where(
			and(
				eq(members.organizationId, organizationId),
				eq(members.descopeUserId, subject),
				eq(members.status, "active"),
			),
		)
		.limit(1);
	return row ?? null;
}
export async function getHistoricalFunding(
	db: DbQueryClient,
	organizationId: string,
) {
	const accounts = coreTable(db, schemaBillingAccounts);
	const plans = coreTable(db, schemaBillingPlanVersions);
	const [account] = await db
		.select()
		.from(accounts)
		.where(eq(accounts.organizationId, organizationId))
		.limit(1);
	if (!account) return null;
	const [plan] = await db
		.select()
		.from(plans)
		.where(eq(plans.id, account.planVersionId))
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
	const exposures = coreTable(db, schemaBillingHistoricalExposures);
	return db
		.select()
		.from(exposures)
		.where(
			and(
				eq(exposures.organizationId, organizationId),
				eq(exposures.tediId, tediId),
			),
		)
		.orderBy(asc(exposures.id));
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
	const decisions = coreTable(db, schemaBillingHistoricalDecisions);
	const [row] = await db
		.select()
		.from(decisions)
		.where(and(eq(decisions.organizationId, org), eq(decisions.tediId, tediId)))
		.orderBy(sql`${decisions.revision} DESC`)
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
	const exposures = coreTable(db, schemaBillingHistoricalExposures);
	// Raw: FROM-less conditional INSERT ... SELECT ... WHERE <fences>; Drizzle cannot build it.
	await db.run(sql`INSERT INTO billing_historical_exposures
 (id,organization_id,tedi_id,object_id,object_name,generation,snapshot_id,source_hash,operation_id,request_hash,exposure,payload,observed_by,observed_user_id,observed_at)
 SELECT ${p.id},${p.organizationId},${p.tediId},${p.objectId},${p.rootObjectName},${p.generation},${p.snapshotId},${p.sourceHash},${input.operationId},${p.requestHash},'UNKNOWN',${jsonParameter(db, p)},${p.observedBy},${p.observedUserId},${p.observedAt}
 WHERE ${memberFence(p.organizationId, p.observedBy, p.observedUserId)} AND ${custodyFence(p.organizationId, p.tediId, p.rootObjectName)}
 ON CONFLICT DO NOTHING`);
	const [row] = await db
		.select()
		.from(exposures)
		.where(
			and(
				eq(exposures.organizationId, p.organizationId),
				eq(exposures.tediId, p.tediId),
				eq(exposures.operationId, input.operationId),
				eq(exposures.requestHash, p.requestHash),
				eq(exposures.objectId, p.objectId),
				eq(exposures.generation, p.generation),
				eq(exposures.snapshotId, p.snapshotId),
				eq(exposures.sourceHash, p.sourceHash),
				sql`${jget(db, exposures.payload, ["rootObjectId"])}=${p.rootObjectId} AND ${jget(db, exposures.payload, ["rootObjectName"])}=${p.rootObjectName} AND ${jget(db, exposures.payload, ["className"])}=${p.className} AND ${jget(db, exposures.payload, ["objectName"])}=${p.objectName} AND ${jeq(db, exposures.payload, ["targetPath"], p.targetPath)}`,
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
	const decisions = coreTable(db, schemaBillingHistoricalDecisions);
	const [prior] = await db
		.select()
		.from(decisions)
		.where(
			and(
				eq(decisions.organizationId, p.organizationId),
				eq(decisions.tediId, p.tediId),
				eq(decisions.operationId, i.operationId),
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
	const fullSet = exposureSetFence(
		db,
		p.organizationId,
		p.tediId,
		members,
		set.rows.length,
	);
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
  AND ${instant(db, sql`a.period_start`)}=${instant(db, f.periodStart)} AND ${instant(db, sql`a.period_end`)}=${instant(db, f.periodEnd)} AND ${isSame(db, sql`a.stripe_environment`, sql`${f.stripeEnvironment}`)}
  AND ${instant(db, sql`a.period_start`)}<=${instant(db, p.recordedAt)} AND ${instant(db, sql`a.period_end`)}>${instant(db, p.recordedAt)}
  AND ${instant(db, i.expiresAt)}<=${instant(db, sql`a.period_end`)} AND ${nowInstant(db)}<${instant(db, i.expiresAt)} AND ${nowInstant(db)}>=${instant(db, sql`a.period_start`)} AND ${nowInstant(db)}<${instant(db, sql`a.period_end`)})`;
	} else if (
		p.kind === "revocation" &&
		"decisionId" in i &&
		p.decisionId === i.decisionId &&
		p.revision === i.expectedRevision + 1
	) {
		operationFence = sql`EXISTS (SELECT 1 FROM billing_historical_decisions original WHERE original.id=${p.decisionId} AND original.organization_id=${p.organizationId} AND original.tedi_id=${p.tediId} AND original.kind='decision' AND ${jget(db, sql`original.payload`, ["authority"])}='records_only')
  AND NOT EXISTS (SELECT 1 FROM billing_historical_decisions r WHERE r.organization_id=${p.organizationId} AND r.tedi_id=${p.tediId} AND r.decision_id=${p.decisionId} AND r.kind='revocation')`;
	} else return null;
	// Raw: FROM-less conditional INSERT ... SELECT ... WHERE <fences>; Drizzle cannot build it.
	await db.run(sql`INSERT INTO billing_historical_decisions (id,organization_id,tedi_id,revision,kind,decision_id,operation_id,request_hash,payload,recorded_by,recorded_user_id,recorded_at)
 SELECT ${p.id},${p.organizationId},${p.tediId},${p.revision},${p.kind},${p.decisionId},${i.operationId},${p.requestHash},${jsonParameter(db, p)},${p.recordedBy},${p.recordedUserId},${p.recordedAt}
 WHERE ${memberFence(p.organizationId, p.recordedBy, p.recordedUserId)} AND ${custodyFence(p.organizationId, p.tediId, objectName)}
 AND COALESCE((SELECT MAX(revision) FROM billing_historical_decisions WHERE organization_id=${p.organizationId} AND tedi_id=${p.tediId}),0)=${i.expectedRevision}
 AND ${operationFence} ON CONFLICT DO NOTHING`);
	// An exact retry returns the ORIGINAL event, even if expired/revoked; never renews it.
	const [row] = await db
		.select()
		.from(decisions)
		.where(
			and(
				eq(decisions.organizationId, p.organizationId),
				eq(decisions.tediId, p.tediId),
				eq(decisions.operationId, i.operationId),
				eq(decisions.requestHash, p.requestHash),
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
	const decisions = coreTable(db, schemaBillingHistoricalDecisions);
	const [row] = await db
		.select()
		.from(decisions)
		.where(
			and(
				eq(decisions.organizationId, organizationId),
				eq(decisions.tediId, tediId),
				eq(decisions.operationId, operationId),
			),
		)
		.limit(1);
	return row ?? null;
}

/**
 * Full fixed exposure-set proof shared by decision and finite-permit fences:
 * the stored set must equal the bound member list exactly, field by field.
 */
function exposureSetFence(
	db: DbQueryClient,
	organizationId: string,
	tediId: string,
	membersJson: string,
	count: number,
): SQL {
	if (!postgres(db))
		return sql`(SELECT COUNT(*) FROM billing_historical_exposures WHERE organization_id=${organizationId} AND tedi_id=${tediId})=${count}
 AND NOT EXISTS (SELECT 1 FROM billing_historical_exposures e WHERE e.organization_id=${organizationId} AND e.tedi_id=${tediId}
 AND NOT EXISTS (SELECT 1 FROM json_each(${membersJson}) j WHERE json_extract(j.value,'$.id')=e.id AND json_extract(j.value,'$.hash')=e.request_hash AND json(json_extract(j.value,'$.payload'))=json(e.payload) AND json_extract(j.value,'$.objectId')=e.object_id AND json_extract(j.value,'$.generation')=e.generation AND json_extract(j.value,'$.snapshotId')=e.snapshot_id AND json_extract(j.value,'$.sourceHash')=e.source_hash AND json_extract(j.value,'$.objectName')=e.object_name))`;
	return sql`(SELECT COUNT(*) FROM billing_historical_exposures WHERE organization_id=${organizationId} AND tedi_id=${tediId})=${count}
 AND NOT EXISTS (SELECT 1 FROM billing_historical_exposures e WHERE e.organization_id=${organizationId} AND e.tedi_id=${tediId}
 AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(${membersJson}::text::jsonb) AS j(value) WHERE (j.value #>> '{id}')=e.id AND (j.value #>> '{hash}')=e.request_hash AND (j.value -> 'payload')=e.payload AND (j.value #>> '{objectId}')=e.object_id AND (j.value #>> '{generation}')::numeric=e.generation AND (j.value #>> '{snapshotId}')=e.snapshot_id AND (j.value #>> '{sourceHash}')=e.source_hash AND (j.value #>> '{objectName}')=e.object_name))`;
}

/** Full fixed recorded-row proof. No original name is replaced by current custody. */
function finiteExposureFence(
	db: DbQueryClient,
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
	if (!postgres(db))
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
	return sql`(SELECT COUNT(*) FROM billing_historical_exposures WHERE organization_id=${p.organizationId} AND tedi_id=${p.tediId})=${p.exposures.length}
 AND NOT EXISTS (SELECT 1 FROM billing_historical_exposures e WHERE e.organization_id=${p.organizationId} AND e.tedi_id=${p.tediId}
 AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(${facts}::text::jsonb) AS j(value) WHERE (j.value #>> '{exposure,id}')=e.id
 AND (j.value -> 'exposure')=e.payload
 AND (j.value #>> '{operationId}')=e.operation_id
 AND (j.value #>> '{exposure,rootObjectName}')=e.object_name
 AND (j.value #>> '{exposure,objectId}')=e.object_id
 AND (j.value #>> '{exposure,generation}')::numeric=e.generation
 AND (j.value #>> '{exposure,snapshotId}')=e.snapshot_id
 AND (j.value #>> '{exposure,sourceHash}')=e.source_hash
 AND (j.value #>> '{exposure,requestHash}')=e.request_hash
 AND (j.value #>> '{exposure,observedBy}')=e.observed_by
 AND (j.value #>> '{exposure,observedUserId}')=e.observed_user_id
 AND (j.value #>> '{exposure,observedAt}')=e.observed_at AND e.exposure='UNKNOWN'))`;
}
function finiteFundingFence(
	db: DbQueryClient,
	p: FiniteExecutionAuthorization,
	live: boolean,
) {
	const f = p.input.funding;
	return sql`EXISTS (SELECT 1 FROM billing_accounts a JOIN billing_plan_versions v ON v.id=a.plan_version_id
 WHERE a.organization_id=${p.organizationId} AND a.status=${f.status} AND a.billing_mode=${f.billingMode}
 AND a.entitlement_version=${f.entitlementVersion} AND a.plan_version_id=${f.planVersionId} AND v.version=${f.planVersion}
 AND ${instant(db, sql`a.period_start`)}=${instant(db, f.periodStart)} AND ${instant(db, sql`a.period_end`)}=${instant(db, f.periodEnd)}
 AND ${isSame(db, sql`a.stripe_environment`, sql`${f.stripeEnvironment}`)} AND ${nowInstant(db)}>=${instant(db, sql`a.period_start`)} AND ${nowInstant(db)}<${instant(db, sql`a.period_end`)}
 AND ${instant(db, p.recordedAt)}>=${instant(db, sql`a.period_start`)} AND ${instant(db, p.recordedAt)}<${instant(db, sql`a.period_end`)}
 AND ${instant(db, p.input.expiresAt)}<=${instant(db, sql`a.period_end`)}
 AND (${live ? 1 : 0}=0 OR ${nowInstant(db)}<${instant(db, p.input.expiresAt)}))`;
}
/** Every scalar driving CAS, revocation or identity must agree with immutable JSON. */
function finiteEventRowFence(
	db: DbQueryClient,
	p: FiniteExecutionAuthorization | FiniteExecutionRevocation,
	alias?: "a",
) {
	const table = sql.identifier(alias ?? "billing_historical_decisions");
	const col = (name: string) => sql`${table}.${sql.identifier(name)}`;
	return sql`${col("id")}=${p.id} AND ${col("organization_id")}=${p.organizationId} AND ${col("tedi_id")}=${p.tediId}
 AND ${col("revision")}=${p.revision} AND ${col("kind")}=${p.kind} AND ${isSame(db, col("decision_id"), sql`${p.decisionId}`)}
 AND ${col("operation_id")}=${p.input.operationId} AND ${col("request_hash")}=${p.requestHash}
 AND ${col("recorded_by")}=${p.recordedBy} AND ${col("recorded_user_id")}=${p.recordedUserId} AND ${col("recorded_at")}=${p.recordedAt}
 AND ${jeq(db, col("payload"), null, p)}`;
}
/** Corrupt event projections must never hide supersession/revocation or redefine revision CAS. */
function finiteLedgerConsistencyFence(
	db: DbQueryClient,
	org: string,
	tedi: string,
) {
	const h = sql`h.payload`;
	const field = (
		path: readonly string[],
		kind: "text" | "number" | "json" = "text",
	) => jget(db, h, path, kind);
	return sql`NOT EXISTS (SELECT 1 FROM billing_historical_decisions h
 WHERE ((h.organization_id=${org} AND h.tedi_id=${tedi})
 OR CASE WHEN ${jvalid(db, h)} THEN (${field(["organizationId"])}=${org} AND ${field(["tediId"])}=${tedi}) ELSE 0 END)
 AND CASE WHEN NOT ${jvalid(db, h)} THEN 1
 WHEN (${field(["authority"])}='finite_execution_permit' OR ${field(["input", "kind"])} IN ('authorize_fresh_execution','revoke_fresh_execution')) THEN
 CASE WHEN ${field(["authority"])}='finite_execution_permit' AND ${isSame(db, sql`h.id`, field(["id"]))}
 AND ${isSame(db, sql`h.organization_id`, field(["organizationId"]))} AND ${isSame(db, sql`h.tedi_id`, field(["tediId"]))}
 AND ${jinteger(db, h, ["revision"])} AND ${isSame(db, sql`h.revision`, field(["revision"], "number"))}
 AND ${jinteger(db, h, ["input", "expectedRevision"])} AND h.revision=${field(["input", "expectedRevision"], "number")}+1
 AND ${isSame(db, sql`h.kind`, field(["kind"]))} AND ${isSame(db, sql`h.decision_id`, field(["decisionId"]))}
 AND ${isSame(db, sql`h.operation_id`, field(["input", "operationId"]))} AND ${isSame(db, sql`h.request_hash`, field(["requestHash"]))}
 AND ${isSame(db, sql`h.recorded_by`, field(["recordedBy"]))} AND ${isSame(db, sql`h.recorded_user_id`, field(["recordedUserId"]))}
 AND ${isSame(db, sql`h.recorded_at`, field(["recordedAt"]))}
 AND ((h.kind='decision' AND ${jtype(db, h, ["input", "freshRootName"])}='string' AND length(${field(["input", "freshRootName"])})>0 AND ${jtype(db, h, ["decisionId"])}='null' AND ${field(["input", "kind"])}='authorize_fresh_execution')
 OR (h.kind='revocation' AND ${jtype(db, h, ["freshRootName"])}='string' AND length(${field(["freshRootName"])})>0 AND ${jtype(db, h, ["decisionId"])}='string' AND ${isSame(db, sql`h.decision_id`, field(["input", "authorizationId"]))} AND ${field(["input", "kind"])}='revoke_fresh_execution'))
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
	const decisions = coreTable(db, schemaBillingHistoricalDecisions);
	const [row] = await db
		.select()
		.from(decisions)
		.where(
			and(
				finiteEventRowFence(db, p),
				memberFence(p.organizationId, p.recordedBy, p.recordedUserId),
				custodyFence(p.organizationId, p.tediId, p.input.freshRootName),
				finiteExposureFence(db, p),
				finiteFundingFence(db, p, false),
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
	// Raw: FROM-less conditional INSERT ... SELECT ... WHERE <fences>; Drizzle cannot build it.
	await db.run(sql`INSERT INTO billing_historical_decisions (id,organization_id,tedi_id,revision,kind,decision_id,operation_id,request_hash,payload,recorded_by,recorded_user_id,recorded_at)
 SELECT ${p.id},${p.organizationId},${p.tediId},${p.revision},'decision',NULL,${p.input.operationId},${p.requestHash},${jsonParameter(db, p)},${p.recordedBy},${p.recordedUserId},${p.recordedAt}
 WHERE ${memberFence(p.organizationId, p.recordedBy, p.recordedUserId)} AND ${custodyFence(p.organizationId, p.tediId, p.input.freshRootName)}
 AND ${finiteLedgerConsistencyFence(db, p.organizationId, p.tediId)}
 AND COALESCE((SELECT MAX(revision) FROM billing_historical_decisions WHERE organization_id=${p.organizationId} AND tedi_id=${p.tediId}),0)=${p.input.expectedRevision}
 AND ${finiteExposureFence(db, p)} AND ${finiteFundingFence(db, p, true)} ON CONFLICT DO NOTHING`);
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
	const decisions = coreTable(db, schemaBillingHistoricalDecisions);
	const original = await db
		.select()
		.from(decisions)
		.where(
			and(
				eq(decisions.id, p.decisionId),
				eq(decisions.organizationId, p.organizationId),
				eq(decisions.tediId, p.tediId),
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
	// Raw: FROM-less conditional INSERT ... SELECT ... WHERE <fences>; Drizzle cannot build it.
	if (!prior)
		await db.run(sql`INSERT INTO billing_historical_decisions (id,organization_id,tedi_id,revision,kind,decision_id,operation_id,request_hash,payload,recorded_by,recorded_user_id,recorded_at)
 SELECT ${p.id},${p.organizationId},${p.tediId},${p.revision},'revocation',${p.decisionId},${p.input.operationId},${p.requestHash},${jsonParameter(db, p)},${p.recordedBy},${p.recordedUserId},${p.recordedAt}
 WHERE ${memberFence(p.organizationId, p.recordedBy, p.recordedUserId)} AND ${custodyFence(p.organizationId, p.tediId, p.freshRootName)}
 AND ${finiteLedgerConsistencyFence(db, p.organizationId, p.tediId)}
 AND COALESCE((SELECT MAX(revision) FROM billing_historical_decisions WHERE organization_id=${p.organizationId} AND tedi_id=${p.tediId}),0)=${p.input.expectedRevision}
 AND EXISTS (SELECT 1 FROM billing_historical_decisions WHERE ${finiteEventRowFence(db, grant.data)})
 AND NOT EXISTS (SELECT 1 FROM billing_historical_decisions WHERE organization_id=${p.organizationId} AND tedi_id=${p.tediId} AND kind='revocation' AND decision_id=${p.decisionId}) ON CONFLICT DO NOTHING`);
	const [row] = await db
		.select()
		.from(decisions)
		.where(
			and(
				finiteEventRowFence(db, retained),
				sql`EXISTS (SELECT 1 FROM billing_historical_decisions a WHERE ${finiteEventRowFence(db, grant.data, "a")})`,
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
	db: DbQueryClient,
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
	return sql`${local ? 1 : 0}=1 AND ${finiteLedgerConsistencyFence(db, p.organizationId, p.tediId)} AND ${custodyFence(p.organizationId, p.tediId, p.input.freshRootName)} AND ${finiteExposureFence(db, p)} AND ${finiteFundingFence(db, p, true)}
 AND ${memberFence(p.organizationId, p.recordedBy, p.recordedUserId)} AND EXISTS (SELECT 1 FROM billing_historical_decisions a WHERE ${finiteEventRowFence(db, p, "a")})
 AND NOT EXISTS (SELECT 1 FROM billing_historical_decisions r WHERE r.organization_id=${p.organizationId} AND r.tedi_id=${p.tediId} AND r.kind='revocation' AND r.decision_id=${p.id})
 AND NOT EXISTS (SELECT 1 FROM billing_historical_decisions a WHERE a.organization_id=${p.organizationId} AND a.tedi_id=${p.tediId} AND a.kind='decision' AND a.revision>${p.revision} AND ${jget(db, sql`a.payload`, ["authority"])}='finite_execution_permit' AND ${jget(db, sql`a.payload`, ["input", "freshRootName"])}=${p.input.freshRootName})
 AND ${instant(db, origin.sendBefore)}>${nowInstant(db)} AND ${instant(db, origin.sendBefore)}<=${instant(db, p.input.expiresAt)}
 AND ${instant(db, origin.sendBefore)}<=${nowPlusSeconds(db, p.input.maxSendDurationSeconds)}`;
}

export async function getFiniteExecutionAuthorization(
	db: DbQueryClient,
	org: string,
	tediId: string,
	id: string,
) {
	const decisions = coreTable(db, schemaBillingHistoricalDecisions);
	const [row] = await db
		.select()
		.from(decisions)
		.where(
			and(
				eq(decisions.id, id),
				eq(decisions.organizationId, org),
				eq(decisions.tediId, tediId),
				eq(decisions.kind, "decision"),
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
		.from(decisions)
		.where(finiteEventRowFence(db, parsed.data))
		.limit(1);
	return verified ?? null;
}

/** Sticky selection follows canonical NAME; physical identity is asserted or retained, never SQL-derived. */
export function nativeExecutionRequiresFinitePermitSql(
	origin: import("@tedix/api-contract/schemas/provider-execution").ProviderExecutionOrigin,
	verifiedCurrentRoot = false,
	db?: object,
) {
	const store = db ?? {};
	const org = origin.root.owner.orgId,
		tedi = origin.root.owner.tediId,
		name = origin.root.objectName;
	const permitKind = postgres(store)
		? sql`((d.payload #>> '{authority}')='finite_execution_permit' OR (d.payload #>> '{input,kind}') IN ('authorize_fresh_execution','revoke_fresh_execution'))
 AND ((d.payload #>> '{input,freshRootName}')=${name} OR (d.payload #>> '{freshRootName}')=${name})`
		: sql`CASE WHEN json_valid(d.payload)=1 THEN
 (json_extract(d.payload,'$.authority')='finite_execution_permit' OR json_extract(d.payload,'$.input.kind') IN ('authorize_fresh_execution','revoke_fresh_execution'))
 AND (json_extract(d.payload,'$.input.freshRootName')=${name} OR json_extract(d.payload,'$.freshRootName')=${name}) ELSE 0 END`;
	const exposureCheck = postgres(store)
		? sql`(e.payload #>> '{className}')='AgentTediDO' AND CASE WHEN jsonb_typeof(e.payload #> '{targetPath}')='array' THEN jsonb_array_length(e.payload #> '{targetPath}') END=0`
		: sql`CASE WHEN json_valid(e.payload)=1 THEN json_extract(e.payload,'$.className')='AgentTediDO' AND json_array_length(e.payload,'$.targetPath')=0 ELSE 1 END`;
	return sql`(${origin.root.generation > 0 || origin.selected.generation > 0 ? 1 : 0}=1
 OR EXISTS (SELECT 1 FROM billing_historical_decisions d WHERE d.organization_id=${org} AND d.tedi_id=${tedi}
 AND ${permitKind})
 OR (${verifiedCurrentRoot ? 1 : 0}=0 AND EXISTS (SELECT 1 FROM billing_historical_exposures e WHERE e.organization_id=${org} AND e.tedi_id=${tedi}
 AND ${exposureCheck})))`;
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
	const integrity = sql`${finiteLedgerConsistencyFence(db, org, tedi)} AND NOT EXISTS (
 SELECT 1 FROM billing_historical_exposures e WHERE CASE WHEN ${jvalid(db, sql`e.payload`)} THEN
 ${jget(db, sql`e.payload`, ["organizationId"])}=${org} AND ${jget(db, sql`e.payload`, ["tediId"])}=${tedi}
 AND (${isDifferent(db, sql`e.organization_id`, sql`${org}`)} OR ${isDifferent(db, sql`e.tedi_id`, sql`${tedi}`)}) ELSE 0 END)`;
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
	const exposures = finiteExposureFence(db, {
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
 AND NOT ${nativeExecutionRequiresFinitePermitSql(origin, currentRoot, db)} AND ${instant(db, window.sendBefore)}>${nowInstant(db)}`;
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
	const finite = await finiteExecutionEligibilityPredicate(db, authorization, {
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
