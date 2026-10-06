import { sha256Hex } from "@tedix/worker-kit/crypto";
import {
	ProviderExecutionOriginSchema,
	ProviderExecutionPolicySchema,
	type ProviderExecutionOrigin,
} from "@tedix/api-contract/schemas/provider-execution";
import type { FiniteExecutionAuthorization } from "@tedix/api-contract/schemas/billing";
import { nativeExecutionEligibilityPredicate } from "./billing/historical-exposure";
import { and, eq, inArray, sql, SQL, Param } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import {
	providerExecutionAttempts,
	type NewProviderExecutionAttemptRow,
	type ProviderExecutionAttemptRow,
} from "../schema/provider-executions";
import {
	providerDeploymentScope,
	readProviderExecutionIdentity,
} from "@tedix/api-contract/schemas/provider-execution";

export function buildProviderExecutionInsertStatement(
	db: DbQueryClient,
	input: NewProviderExecutionAttemptRow,
	guard?: ProviderExecutionAdmissionGuard,
) {
	const identity = readProviderExecutionIdentity(input);
	if (input.deploymentScope !== providerDeploymentScope(identity))
		throw new Error("Execution scope mismatch");
	const capturedPredicate = providerExecutionGuardPredicate(input, guard);
	const eligibility = guard
		? sql`WITH __provider_eligibility(eligible) AS MATERIALIZED ${capturedPredicate}`
		: sql``;
	const predicate = guard
		? sql`(SELECT eligible FROM __provider_eligibility)`
		: capturedPredicate;
	const reservation = sql`EXISTS (SELECT 1 FROM billing_usage_reservations WHERE id = ${input.billingReservationId ?? null} AND organization_id = ${input.organizationId} AND idempotency_key = ${input.idempotencyKey} AND status = 'reserved' AND provider = ${identity.provider} AND model = ${identity.requestModel} AND source = ${input.source} AND tedi_id IS ${input.tediId ?? null} AND run_id IS ${input.runId ?? null} AND trace_id IS ${input.traceId ?? null})`;
	// A second-statement refusal after reserving aborts the actual D1 batch instead of committing an orphan hold.
	const finalPredicate =
		guard && input.billingReservationId
			? sql`CASE WHEN ${reservation} THEN CASE WHEN ${predicate} THEN 1 ELSE json('provider_admission_refused') END ELSE 0 END`
			: sql`${predicate} AND (${input.billingReservationId ?? null} IS NULL OR ${reservation})`;
	return db.run(sql`${eligibility} INSERT INTO provider_execution_attempts (id, organization_id, tedi_id, source, run_id, work_item_id, trace_id, idempotency_key, settlement_mode, billing_reservation_id, provider, request_model, gateway_account_id, gateway_id, transport_kind, api_kind, provider_resource, provider_origin, deployment, deployment_scope, authorized_at, send_before, origin, origin_hash, policy, policy_hash)
 SELECT ${input.id}, ${input.organizationId}, ${input.tediId ?? null}, ${input.source}, ${input.runId ?? null}, ${input.workItemId ?? null}, ${input.traceId ?? null}, ${input.idempotencyKey}, ${input.settlementMode}, ${input.billingReservationId ?? null}, ${identity.provider}, ${identity.requestModel}, ${identity.gatewayAccountId}, ${identity.gatewayId}, ${identity.transportKind}, ${identity.apiKind}, ${identity.providerResource}, ${identity.providerOrigin}, ${identity.deployment}, ${input.deploymentScope}, ${input.authorizedAt}, ${input.sendBefore}, ${input.origin ? JSON.stringify(input.origin) : null}, ${input.originHash ?? null}, ${input.policy ? JSON.stringify(input.policy) : null}, ${input.policyHash ?? null}
 WHERE ${finalPredicate}`);
}

export async function findProviderExecutionAdmission(
	db: DbQueryClient,
	organizationId: string,
	idempotencyKey: string,
	guard?: ProviderExecutionAdmissionGuard,
) {
	const [row] = await db
		.select()
		.from(providerExecutionAttempts)
		.where(
			and(
				eq(providerExecutionAttempts.organizationId, organizationId),
				eq(providerExecutionAttempts.idempotencyKey, idempotencyKey),
				guard ? providerExecutionRetryPredicate(guard) : undefined,
			),
		)
		.limit(1);
	return row ?? null;
}

export function assertProviderExecutionMatches(
	row: ProviderExecutionAttemptRow,
	expected: NewProviderExecutionAttemptRow,
) {
	for (const key of [
		"organizationId",
		"tediId",
		"source",
		"runId",
		"workItemId",
		"traceId",
		"settlementMode",
	] as const)
		if ((row[key] ?? null) !== (expected[key] ?? null))
			throw new Error("Execution admission idempotency conflict");
	for (const key of ["originHash", "policyHash"] as const)
		if ((row[key] ?? null) !== (expected[key] ?? null))
			throw new Error("Execution provenance conflict");
	for (const key of ["origin", "policy"] as const)
		if (
			JSON.stringify(row[key] ?? null) !== JSON.stringify(expected[key] ?? null)
		)
			throw new Error("Execution provenance conflict");
	if (
		expected.origin &&
		(row.id !== expected.id ||
			row.billingReservationId !== expected.billingReservationId ||
			row.authorizedAt !== expected.authorizedAt ||
			row.sendBefore !== expected.sendBefore)
	)
		throw new Error("Execution original window conflict");
	if (
		JSON.stringify(readProviderExecutionIdentity(row)) !==
		JSON.stringify(readProviderExecutionIdentity(expected))
	)
		throw new Error("Execution admission identity conflict");
}

/** Trusted gateway ingestion owns this bounded cross-tenant correlation lookup. */
export async function getProviderExecutionsByIds(
	db: DbQueryClient,
	ids: string[],
): Promise<ProviderExecutionAttemptRow[]> {
	const rows: ProviderExecutionAttemptRow[] = [];
	const unique = [...new Set(ids)];
	for (let i = 0; i < unique.length; i += 50)
		rows.push(
			...(await db
				.select()
				.from(providerExecutionAttempts)
				.where(inArray(providerExecutionAttempts.id, unique.slice(i, i + 50)))),
		);
	return rows;
}

/** Private typed preparation; never serialized or supplied as arbitrary request SQL. */
export interface ProviderExecutionAdmissionGuard {
	readonly kind: "provider_execution_admission";
}
const guards = new WeakMap<
	ProviderExecutionAdmissionGuard,
	{ execution: NewProviderExecutionAttemptRow; pin: string; predicate: SQL }
>();
export async function prepareProviderExecutionAdmission(
	db: DbQueryClient,
	input: NewProviderExecutionAttemptRow,
	origin: ProviderExecutionOrigin,
	authorization: FiniteExecutionAuthorization | null = null,
) {
	origin = ProviderExecutionOriginSchema.parse(origin);
	if (
		input.organizationId !== origin.root.owner.orgId ||
		input.tediId !== origin.root.owner.tediId ||
		(origin.kind === "accepted_native" &&
			input.runId !== origin.root.accepted.runId)
	)
		throw new Error("Execution asserted owner conflict");
	const policy = authorization
		? ProviderExecutionPolicySchema.parse({
				authorizationId: authorization.id,
				authorizationRequestHash: authorization.requestHash,
				revision: authorization.revision,
				exposureSetHash: authorization.input.exposureSetHash,
				authorizedAt: input.authorizedAt,
				sendBefore: input.sendBefore,
			})
		: null;
	const execution = {
		...input,
		origin,
		originHash: await sha256Hex(JSON.stringify(origin)),
		policy,
		policyHash: policy ? await sha256Hex(JSON.stringify(policy)) : null,
	};
	const predicate = await nativeExecutionEligibilityPredicate(
		db,
		origin,
		authorization,
		{
			authorizedAt: execution.authorizedAt,
			sendBefore: execution.sendBefore,
			settlementMode: execution.settlementMode,
		},
	);
	const guard: ProviderExecutionAdmissionGuard = Object.freeze({
		kind: "provider_execution_admission",
	});
	const snapshot = structuredClone(execution);
	guards.set(guard, {
		execution: snapshot,
		pin: JSON.stringify(snapshot),
		predicate: compactAdmissionPredicate(predicate),
	});
	return { execution, guard };
}
function guardFacts(guard: ProviderExecutionAdmissionGuard) {
	const facts = guards.get(guard);
	if (!facts) throw new Error("Invalid private execution guard");
	return facts;
}
export function providerExecutionGuardPredicate(
	input: NewProviderExecutionAttemptRow,
	guard?: ProviderExecutionAdmissionGuard,
): SQL {
	if (!guard) {
		if (
			input.origin != null ||
			input.originHash != null ||
			input.policy != null ||
			input.policyHash != null
		)
			throw new Error("Execution provenance requires prepared guard");
		return sql`1=1`;
	}
	const facts = guardFacts(guard);
	if (JSON.stringify(input) !== facts.pin)
		throw new Error("Execution guard identity changed");
	return facts.predicate;
}
export function providerExecutionRetryPredicate(
	guard: ProviderExecutionAdmissionGuard,
): SQL {
	const { execution: e, predicate } = guardFacts(guard);
	const identity = balancedConjunction([
		sql`organization_id=${e.organizationId}`,
		sql`idempotency_key=${e.idempotencyKey}`,
		sql`tedi_id IS ${e.tediId ?? null}`,
		sql`id=${e.id}`,
		sql`billing_reservation_id IS ${e.billingReservationId ?? null}`,
		sql`source=${e.source}`,
		sql`run_id IS ${e.runId ?? null}`,
		sql`work_item_id IS ${e.workItemId ?? null}`,
		sql`trace_id IS ${e.traceId ?? null}`,
		sql`settlement_mode=${e.settlementMode}`,
		sql`origin_hash=${e.originHash}`,
		sql`json(origin)=json(${JSON.stringify(e.origin)})`,
		sql`policy_hash IS ${e.policyHash ?? null}`,
		sql`policy IS ${e.policy ? JSON.stringify(e.policy) : null}`,
		sql`authorized_at=${e.authorizedAt}`,
		sql`send_before=${e.sendBefore}`,
		sql`provider=${e.provider}`,
		sql`request_model=${e.requestModel}`,
		sql`gateway_account_id IS ${e.gatewayAccountId ?? null}`,
		sql`gateway_id IS ${e.gatewayId ?? null}`,
		sql`transport_kind=${e.transportKind}`,
		sql`api_kind=${e.apiKind}`,
		sql`provider_resource IS ${e.providerResource ?? null}`,
		sql`provider_origin IS ${e.providerOrigin ?? null}`,
		sql`deployment IS ${e.deployment ?? null}`,
		sql`deployment_scope=${e.deploymentScope}`,
	]);
	// Materialize the original eligibility independently of the correlated receipt
	// identity. Balanced terms keep both direct and reservation retries within D1's
	// expression-depth limit without changing the owning admission predicate.
	return sql`(WITH __provider_eligibility(eligible) AS MATERIALIZED ${predicate}
 SELECT ${identity} AND eligible FROM __provider_eligibility)`;
}

function balancedConjunction(conditions: readonly [SQL, ...SQL[]]): SQL {
	const combine = (start: number, end: number): SQL => {
		if (end - start === 1) return conditions[start]!;
		const midpoint = start + Math.floor((end - start) / 2);
		return sql`(${combine(start, midpoint)} AND ${combine(midpoint, end)})`;
	};
	return combine(0, conditions.length);
}

/** Bind the captured SQL policy once; the D1 100-parameter limit also covers its outer batch statements. */
function compactAdmissionPredicate(predicate: SQL): SQL {
	const values: unknown[] = [];
	const visit = (statement: SQL): SQL =>
		new SQL(
			statement.queryChunks.map((chunk) => {
				if (chunk instanceof SQL) return visit(chunk);
				if (
					chunk instanceof Param ||
					chunk === null ||
					["string", "number", "boolean"].includes(typeof chunk)
				) {
					const index = values.length;
					values.push(
						chunk instanceof Param
							? chunk.value === null
								? null
								: chunk.encoder.mapToDriverValue(chunk.value)
							: chunk,
					);
					return sql`json_extract(__provider_policy.value, ${sql.raw(`'$[${index}]'`)})`;
				}
				return chunk;
			}),
		);
	const captured = visit(predicate);
	return sql`(SELECT ${captured} FROM json_each(${JSON.stringify([values])}) AS __provider_policy)`;
}
