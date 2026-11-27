import { sha256Hex } from "@tedix/worker-kit/crypto";
import {
	ProviderExecutionOriginSchema,
	FiniteProviderExecutionPolicySchema,
	AutoRouterExecutionPolicySchema,
	type ProviderExecutionOrigin,
} from "@tedix/api-contract/schemas/provider-execution";
import {
	FiniteExecutionAuthorizationSchema,
	type FiniteExecutionAuthorization,
} from "@tedix/api-contract/schemas/billing";
import { nativeExecutionEligibilityPredicate } from "./billing/historical-exposure";
import { and, eq, sql, SQL, Param } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import { coreTable } from "../core-store/client";
import { anyIds, coreStore, jsonParameter } from "../core-store/dialect";
import { mergeLogStoreRows, readLogStores } from "../utils/log-store";
import {
	providerExecutionAttempts as schemaProviderExecutionAttempts,
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
	if (identity.requestModel === "cloudflare/auto" && !guard)
		throw Error("Auto execution requires prepared routing guard");
	if (input.deploymentScope !== providerDeploymentScope(identity))
		throw new Error("Execution scope mismatch");
	const capturedPredicate = providerExecutionGuardPredicate(input, guard);
	// Stays raw: Drizzle's $with cannot emit AS MATERIALIZED ahead of an INSERT.
	const eligibility = guard
		? sql`WITH __provider_eligibility(eligible) AS MATERIALIZED ${capturedPredicate}`
		: sql``;
	const predicate = guard
		? sql`(SELECT eligible FROM __provider_eligibility)`
		: capturedPredicate;
	// Managed credits are held by the organization wallet before this insert;
	// the fence only proves the dispatch identity and policy guard.
	return db.run(sql`${eligibility} INSERT INTO provider_execution_attempts (id, organization_id, tedi_id, source, run_id, work_item_id, trace_id, idempotency_key, settlement_mode, billing_reservation_id, provider, request_model, gateway_account_id, gateway_id, transport_kind, api_kind, provider_resource, provider_origin, deployment, deployment_scope, authorized_at, send_before, origin, origin_hash, policy, policy_hash)
 SELECT ${input.id}, ${input.organizationId}, ${input.tediId ?? null}, ${input.source}, ${input.runId ?? null}, ${input.workItemId ?? null}, ${input.traceId ?? null}, ${input.idempotencyKey}, ${input.settlementMode}, ${input.billingReservationId ?? null}, ${identity.provider}, ${identity.requestModel}, ${identity.gatewayAccountId}, ${identity.gatewayId}, ${identity.transportKind}, ${identity.apiKind}, ${identity.providerResource}, ${identity.providerOrigin}, ${identity.deployment}, ${input.deploymentScope}, ${input.authorizedAt}, ${input.sendBefore}, ${input.origin ? jsonParameter(db, input.origin) : null}, ${input.originHash ?? null}, ${input.policy ? jsonParameter(db, input.policy) : null}, ${input.policyHash ?? null}
 WHERE ${predicate}`);
}

export async function findProviderExecutionAdmission(
	db: DbQueryClient,
	organizationId: string,
	idempotencyKey: string,
	guard?: ProviderExecutionAdmissionGuard,
) {
	const providerExecutionAttempts = coreTable(
		db,
		schemaProviderExecutionAttempts,
	);
	const [row] = await db
		.select()
		.from(providerExecutionAttempts)
		.where(
			and(
				eq(providerExecutionAttempts.organizationId, organizationId),
				eq(providerExecutionAttempts.idempotencyKey, idempotencyKey),
				guard ? providerExecutionRetryPredicate(guard, db) : undefined,
			),
		)
		.limit(1);
	return row ?? null;
}

/** Postgres jsonb does not keep key order, so stored JSON compares by content. */
function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_key, item: unknown) =>
		item && typeof item === "object" && !Array.isArray(item)
			? Object.fromEntries(
					Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
				)
			: item,
	);
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
			canonicalJson(row[key] ?? null) !== canonicalJson(expected[key] ?? null)
		)
			throw new Error("Execution provenance conflict");
	if (
		(expected.origin ||
			(expected.policy &&
				"kind" in expected.policy &&
				expected.policy.kind === "auto_router_v1")) &&
		(row.id !== expected.id ||
			row.billingReservationId !== expected.billingReservationId ||
			row.authorizedAt !== expected.authorizedAt ||
			row.sendBefore !== expected.sendBefore)
	)
		throw new Error("Execution original window conflict");
	if (
		canonicalJson(readProviderExecutionIdentity(row)) !==
		canonicalJson(readProviderExecutionIdentity(expected))
	)
		throw new Error("Execution admission identity conflict");
}

/** Trusted gateway ingestion owns this bounded cross-tenant correlation lookup. */
export async function getProviderExecutionsByIds(
	db: DbQueryClient,
	ids: string[],
): Promise<ProviderExecutionAttemptRow[]> {
	if (!ids.length) return [];
	const pages = await readLogStores(db, (store) =>
		getProviderExecutionsByIds(store, ids),
	);
	if (pages) return mergeLogStoreRows(pages);
	const providerExecutionAttempts = coreTable(
		db,
		schemaProviderExecutionAttempts,
	);
	// Bind the bounded ingestion ID set as one value rather than one parameter per ID.
	return db
		.select()
		.from(providerExecutionAttempts)
		.where(anyIds(db, providerExecutionAttempts.id, [...new Set(ids)]));
}

/** Private typed preparation; never serialized or supplied as arbitrary request SQL. */
export interface ProviderExecutionAdmissionGuard {
	readonly kind: "provider_execution_admission";
}
const guards = new WeakMap<
	ProviderExecutionAdmissionGuard,
	{
		execution: NewProviderExecutionAttemptRow;
		pin: string;
		predicate: SQL;
	}
>();
export async function prepareProviderExecutionAdmission(
	db: DbQueryClient,
	input: NewProviderExecutionAttemptRow,
	origin: ProviderExecutionOrigin,
	authorization: FiniteExecutionAuthorization | null = null,
) {
	input = structuredClone(input);
	authorization =
		authorization === null
			? null
			: FiniteExecutionAuthorizationSchema.parse(authorization);
	origin = ProviderExecutionOriginSchema.parse(origin);
	if (
		input.organizationId !== origin.root.owner.orgId ||
		input.tediId !== origin.root.owner.tediId ||
		(origin.kind === "accepted_native" &&
			input.runId !== origin.root.accepted.runId)
	)
		throw new Error("Execution asserted owner conflict");
	const finite = authorization
		? FiniteProviderExecutionPolicySchema.parse({
				authorizationId: authorization.id,
				authorizationRequestHash: authorization.requestHash,
				revision: authorization.revision,
				exposureSetHash: authorization.input.exposureSetHash,
				authorizedAt: input.authorizedAt,
				sendBefore: input.sendBefore,
			})
		: null;
	const identity = readProviderExecutionIdentity(input);
	const policy =
		identity.requestModel === "cloudflare/auto"
			? AutoRouterExecutionPolicySchema.parse({
					kind: "auto_router_v1",
					routing: identity.autoRouting,
					finite,
				})
			: finite;
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
		// Postgres has no D1 parameter cap; keep the subquery shape compaction gives D1.
		predicate:
			coreStore(db) === "postgres"
				? sql`(SELECT ${predicate})`
				: compactAdmissionPredicate(predicate),
	});
	return { execution, guard };
}
/** Server service validates the deployment routing before this private kernel-only preparation. */
export async function prepareKernelAutoRoutingAdmission(
	input: NewProviderExecutionAttemptRow,
) {
	input = structuredClone(input);
	const identity = readProviderExecutionIdentity(input);
	if (
		identity.requestModel !== "cloudflare/auto" ||
		!identity.autoRouting ||
		input.origin != null ||
		input.originHash != null ||
		input.policy != null ||
		input.policyHash != null
	)
		throw Error(
			"Kernel Auto routing preparation requires original unguarded kernel tuple",
		);
	const policy = AutoRouterExecutionPolicySchema.parse({
		kind: "auto_router_v1",
		routing: identity.autoRouting,
		finite: null,
	});
	const execution = {
		...input,
		origin: null,
		originHash: null,
		policy,
		policyHash: await sha256Hex(JSON.stringify(policy)),
	};
	const guard: ProviderExecutionAdmissionGuard = Object.freeze({
		kind: "provider_execution_admission",
	});
	const snapshot = structuredClone(execution);
	guards.set(guard, {
		execution: snapshot,
		pin: JSON.stringify(snapshot),
		predicate: compactAdmissionPredicate(sql`1=1`),
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
	db: object,
): SQL {
	const { execution: e, predicate } = guardFacts(guard);
	const postgres = coreStore(db) === "postgres";
	// SQLite's `IS` takes any operand; Postgres needs IS NOT DISTINCT FROM.
	const same = (column: string, value: string | null | undefined) =>
		postgres
			? sql`${sql.identifier(column)} IS NOT DISTINCT FROM ${value ?? null}::text`
			: sql`${sql.identifier(column)} IS ${value ?? null}`;
	const identity = balancedConjunction([
		sql`organization_id=${e.organizationId}`,
		sql`idempotency_key=${e.idempotencyKey}`,
		same("tedi_id", e.tediId),
		sql`id=${e.id}`,
		same("billing_reservation_id", e.billingReservationId),
		sql`source=${e.source}`,
		same("run_id", e.runId),
		same("work_item_id", e.workItemId),
		same("trace_id", e.traceId),
		sql`settlement_mode=${e.settlementMode}`,
		e.originHash == null
			? sql`origin_hash IS NULL`
			: sql`origin_hash=${e.originHash}`,
		e.origin == null
			? sql`origin IS NULL`
			: postgres
				? sql`origin=${JSON.stringify(e.origin)}::text::jsonb`
				: sql`json(origin)=json(${JSON.stringify(e.origin)})`,
		same("policy_hash", e.policyHash),
		e.policy == null
			? sql`policy IS NULL`
			: postgres
				? sql`policy=${JSON.stringify(e.policy)}::text::jsonb`
				: sql`policy IS ${JSON.stringify(e.policy)}`,
		sql`authorized_at=${e.authorizedAt}`,
		sql`send_before=${e.sendBefore}`,
		sql`provider=${e.provider}`,
		sql`request_model=${e.requestModel}`,
		same("gateway_account_id", e.gatewayAccountId),
		same("gateway_id", e.gatewayId),
		sql`transport_kind=${e.transportKind}`,
		sql`api_kind=${e.apiKind}`,
		same("provider_resource", e.providerResource),
		same("provider_origin", e.providerOrigin),
		same("deployment", e.deployment),
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
export function compactAdmissionPredicate(predicate: SQL): SQL {
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
					if (chunk instanceof Param) {
						const value =
							chunk.value === null
								? null
								: chunk.encoder.mapToDriverValue(chunk.value);
						values.push(chunk.codec ? chunk.codec(value) : value);
					} else values.push(chunk);
					// sql.raw keeps the JSON path a literal; binding it would spend the params this compacts.
					return sql`json_extract(__provider_policy.value, ${sql.raw(`'$[${index}]'`)})`;
				}
				return chunk;
			}),
		);
	const captured = visit(predicate);
	// Without bound values the subquery reads nothing, which also keeps it valid on Postgres.
	if (!values.length) return sql`(SELECT ${captured})`;
	return sql`(SELECT ${captured} FROM json_each(${JSON.stringify([values])}) AS __provider_policy)`;
}
