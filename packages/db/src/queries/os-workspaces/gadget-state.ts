import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import {
	osGadgetState,
	osGadgetStateMutations,
	type OsGadgetStateRow,
	type OsGadgetStateMutationRow,
} from "../../schema/os-gadget-state";
import {
	osGadgets,
	osWorkspaces,
	osGadgetExecutions,
} from "../../schema/os-workspaces";
import { skillRuns } from "../../schema/cognitive";

/** Tenant and application scope fixed by API authority, never inferred from the state key. */
export interface GadgetStateScope {
	organizationId: string;
	workspaceId: string;
	gadgetId: string;
}
function scopeWhere(scope: GadgetStateScope) {
	return and(
		eq(osGadgetState.organizationId, scope.organizationId),
		eq(osGadgetState.workspaceId, scope.workspaceId),
		eq(osGadgetState.gadgetId, scope.gadgetId),
	);
}
/** Read including tombstones so a later writer cannot accidentally resurrect at revision zero. */
export async function getGadgetState(
	db: DbQueryClient,
	scope: GadgetStateScope,
	key: string,
): Promise<OsGadgetStateRow | undefined> {
	const [row] = await db
		.select()
		.from(osGadgetState)
		.where(and(scopeWhere(scope), eq(osGadgetState.key, key)))
		.limit(1);
	return row;
}
/** Stable keyset pagination; prefix characters are compared literally. */
export async function listGadgetState(
	db: DbQueryClient,
	scope: GadgetStateScope,
	input: { prefix?: string; after?: string; limit: number },
): Promise<OsGadgetStateRow[]> {
	return db
		.select()
		.from(osGadgetState)
		.where(
			and(
				scopeWhere(scope),
				input.prefix
					? sql`substr(${osGadgetState.key}, 1, ${input.prefix.length}) = ${input.prefix}`
					: undefined,
				input.after ? gt(osGadgetState.key, input.after) : undefined,
			),
		)
		.orderBy(asc(osGadgetState.key))
		.limit(Math.min(input.limit, 101));
}
/** Query-time execution fence also used inside the mutation transaction. */
export interface GadgetStateFence extends GadgetStateScope {
	executionId: string;
	executionEpoch: number;
	tediId: string;
	revisionId: string;
	runtimeEnvironment: string;
	capability: string;
}
function liveFence(p: GadgetStateFence) {
	return sql`EXISTS (SELECT 1 FROM ${osGadgetExecutions}
 JOIN ${osGadgets} ON ${osGadgets.id} = ${osGadgetExecutions.gadgetId} AND ${osGadgets.organizationId} = ${osGadgetExecutions.organizationId}
 JOIN ${osWorkspaces} ON ${osWorkspaces.id} = ${osGadgets.workspaceId} AND ${osWorkspaces.organizationId} = ${osGadgets.organizationId}
 JOIN ${skillRuns} ON ${skillRuns.id} = ${osGadgetExecutions.runId} AND ${skillRuns.organizationId} = ${osGadgetExecutions.organizationId}
 WHERE ${osGadgetExecutions.id} = ${p.executionId} AND ${osGadgetExecutions.organizationId} = ${p.organizationId}
 AND ${osGadgetExecutions.workspaceId} = ${p.workspaceId} AND ${osGadgetExecutions.gadgetId} = ${p.gadgetId}
 AND ${osGadgetExecutions.revisionId} = ${p.revisionId} AND ${osGadgets.currentRevisionId} = ${p.revisionId}
 AND ${osGadgetExecutions.tediId} = ${p.tediId} AND ${skillRuns.tediId} = ${p.tediId}
 AND ${osGadgetExecutions.executionEpoch} = ${p.executionEpoch} AND ${skillRuns.executionEpoch} = ${p.executionEpoch}
 AND ${osGadgetExecutions.status} = 'running' AND ${skillRuns.status} = 'running'
 AND ${skillRuns.workflowRetiredAt} IS NULL AND ${skillRuns.restartRequestedAt} IS NULL
 AND ${skillRuns.runtimeEnvironment} = ${p.runtimeEnvironment} AND ${osGadgetExecutions.runtimeEnvironment} = ${p.runtimeEnvironment}
 AND ${osGadgets.status} = 'active' AND ${osWorkspaces.status} = 'active'
 AND json_extract(${osGadgetExecutions.policyDecision}, '$.allowed') = 1
 AND EXISTS (SELECT 1 FROM json_each(${osGadgetExecutions.grantedCapabilities}) WHERE value = ${p.capability}))`;
}
/** Read the exact linked runtime ledger for service-layer identity validation. */
export async function hasLiveGadgetStateFence(
	db: DbQueryClient,
	p: GadgetStateFence,
): Promise<boolean> {
	const [row] = await db
		.select({ id: osGadgets.id })
		.from(osGadgets)
		.where(and(eq(osGadgets.id, p.gadgetId), liveFence(p)))
		.limit(1);
	return Boolean(row);
}
/** One CAS attempt; all receipt and value changes execute atomically in a D1 batch. */
export interface MutateGadgetStateParams extends GadgetStateFence {
	key: string;
	expectedRevision: number;
	idempotencyKey: string;
	digest: string;
	value: string | null;
	deleted: boolean;
	accessEnvelope: string;
	now: string;
}
export async function mutateGadgetState(
	db: DbQueryClient,
	p: MutateGadgetStateParams,
): Promise<OsGadgetStateMutationRow> {
	const receiptWhere = and(
		eq(osGadgetStateMutations.organizationId, p.organizationId),
		eq(osGadgetStateMutations.gadgetId, p.gadgetId),
		eq(osGadgetStateMutations.idempotencyKey, p.idempotencyKey),
	);
	const pending = sql`EXISTS (SELECT 1 FROM ${osGadgetStateMutations} WHERE organization_id=${p.organizationId} AND gadget_id=${p.gadgetId} AND idempotency_key=${p.idempotencyKey} AND digest=${p.digest} AND status='pending')`;
	const reserve = db
		.insert(osGadgetStateMutations)
		.values({
			organizationId: p.organizationId,
			gadgetId: p.gadgetId,
			idempotencyKey: p.idempotencyKey,
			digest: p.digest,
			status: "pending",
			createdAt: p.now,
		})
		.onConflictDoNothing();
	const value = db
		.insert(osGadgetState)
		.select(
			db
				.select({
					organizationId: sql<string>`${p.organizationId}`.as(
						"organization_id",
					),
					workspaceId: sql<string>`${p.workspaceId}`.as("workspace_id"),
					gadgetId: sql<string>`${p.gadgetId}`.as("gadget_id"),
					key: sql<string>`${p.key}`.as("key"),
					revision: sql<number>`${p.expectedRevision + 1}`.as("revision"),
					value: sql<string | null>`${p.value}`.as("value"),
					deleted: sql<boolean>`${p.deleted ? 1 : 0}`.as("deleted"),
					accessEnvelope: sql<string>`${p.accessEnvelope}`.as(
						"access_envelope",
					),
					executionId: sql<string>`${p.executionId}`.as("execution_id"),
					lastMutationId: sql<string>`${p.idempotencyKey}`.as(
						"last_mutation_id",
					),
					updatedAt: sql<string>`${p.now}`.as("updated_at"),
				})
				.from(osGadgets)
				.where(
					and(
						eq(osGadgets.id, p.gadgetId),
						pending,
						liveFence(p),
						sql`(${p.expectedRevision}=0 OR EXISTS (SELECT 1 FROM ${osGadgetState} WHERE organization_id=${p.organizationId} AND gadget_id=${p.gadgetId} AND key=${p.key}))`,
					),
				),
		)
		.onConflictDoUpdate({
			target: [
				osGadgetState.organizationId,
				osGadgetState.gadgetId,
				osGadgetState.key,
			],
			set: {
				revision: p.expectedRevision + 1,
				value: p.value,
				deleted: p.deleted,
				accessEnvelope: p.accessEnvelope,
				executionId: p.executionId,
				lastMutationId: p.idempotencyKey,
				updatedAt: p.now,
			},
			where: and(
				eq(osGadgetState.workspaceId, p.workspaceId),
				eq(osGadgetState.revision, p.expectedRevision),
				pending,
				liveFence(p),
			),
		});
	const applied = sql`EXISTS (SELECT 1 FROM ${osGadgetState} WHERE organization_id=${p.organizationId} AND gadget_id=${p.gadgetId} AND key=${p.key} AND last_mutation_id=${p.idempotencyKey})`;
	const settle = db
		.update(osGadgetStateMutations)
		.set({
			status: sql`CASE WHEN ${applied} THEN 'applied' ELSE 'conflict' END`,
			result: sql`CASE WHEN ${applied} THEN (SELECT json_object('key',key,'revision',revision,'value',json(value),'deleted',json(CASE WHEN deleted=1 THEN 'true' ELSE 'false' END),'accessEnvelope',json(access_envelope),'executionId',execution_id,'updatedAt',updated_at) FROM ${osGadgetState} WHERE organization_id=${p.organizationId} AND gadget_id=${p.gadgetId} AND key=${p.key}) ELSE NULL END`,
		})
		.where(
			and(
				receiptWhere,
				eq(osGadgetStateMutations.digest, p.digest),
				eq(osGadgetStateMutations.status, "pending"),
			),
		);
	const result = db
		.select()
		.from(osGadgetStateMutations)
		.where(receiptWhere)
		.limit(1);
	const [, , , rows] = await db.batch([reserve, value, settle, result]);
	const receipt = rows[0];
	if (!receipt) throw new Error("Gadget state mutation returned no receipt");
	return receipt;
}
