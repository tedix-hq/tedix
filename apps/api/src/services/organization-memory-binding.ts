import { evaluateCall } from "@tedix/agent-governance/compliance";
import type {
	AccountabilityAdapter,
	Actor,
	MemoryProvenance,
	MemoryRevision,
	Source,
} from "@tedix/agent-governance/types";
import { guardedCall } from "@tedix/agent-governance/wrap-binding";
import {
	OrganizationMemoryAdapter,
	factReviewState,
	type FactReviewUpdates,
	type FactMutationUpdates,
} from "@tedix/db/queries/memory-graph/memory-adapter";
import type { MemoryFact, NewMemoryFact } from "@tedix/db/schema/memory-graph";
import type { DbQueryClient } from "@tedix/db/query-client";
import { auditActor } from "../rpc/audit-helpers";
import type { BaseContext } from "../rpc/context";
import {
	appendChangeRecord,
	getChangeRecord,
	listChangeRecords,
} from "./organization-log";

/** Call only after the procedure's existing authorization and admission checks. */
async function recordOrganizationMemoryChange<
	T extends { revision: MemoryRevision },
>(
	db: DbQueryClient,
	fact: { id: string; organizationId: string },
	actor: Actor,
	source: Source,
	operation: string,
	args: unknown,
	execute: (provenance: MemoryProvenance) => Promise<T>,
): Promise<T> {
	const changeRecordId = crypto.randomUUID();
	const accountability: AccountabilityAdapter = {
		append: async (record) =>
			Object.freeze(
				await appendChangeRecord(fact.organizationId, {
					...record,
					id: changeRecordId,
				}),
			),
		get: (id) => getChangeRecord(fact.organizationId, id),
		list: (query) => listChangeRecords(fact.organizationId, query ?? {}),
		export: async () => ({
			exportedAt: new Date().toISOString(),
			records: await listChangeRecords(fact.organizationId, {}),
		}),
	};
	const { result } = await guardedCall(
		{
			actor,
			source,
			resource: `memory:organization:${fact.id}`,
			operation,
			args,
			riskTier: "bounded_write",
			blastRadius: "single_resource",
		},
		() => execute({ actor, source, changeRecordId }),
		{
			compliance: {
				check: async (call) =>
					evaluateCall({
						riskTier: call.riskTier,
						blastRadius: call.blastRadius,
						approval: "not_required",
					}),
				record: async () => {},
			},
			accountability,
			after: async ({ revision }) => ({
				revisionId: revision.revisionId,
				hash: revision.hash,
			}),
		},
	);
	return result;
}

export async function storeOrganizationMemoryReview(
	db: DbQueryClient,
	fact: MemoryFact,
	updates: FactReviewUpdates,
	actor: Actor,
): Promise<void> {
	const adapter = new OrganizationMemoryAdapter(db, {
		organizationId: fact.organizationId,
	});
	await recordOrganizationMemoryChange(
		db,
		fact,
		actor,
		{ surface: "memory_graph_review" },
		"review",
		{ factId: fact.id, ...updates },
		async (provenance) => ({
			revision: await adapter.write(
				{
					key: fact.id,
					value: fact.content,
					provenance,
					review: factReviewState(updates.reviewStatus ?? fact.reviewStatus),
					reviewedBy: actor.id,
					reviewedAt: new Date().toISOString(),
				},
				{ fact, updates },
			),
		}),
	);
}

/** One accountable write per changed fact, including secondary lifecycle changes. */
export function organizationMemoryWriter(
	context: BaseContext,
	surface: string,
) {
	const initiatingActor = auditActor(context);
	const actorFor = (organizationId: string): Actor => ({
		id: initiatingActor.actorId,
		kind: initiatingActor.actorType,
		organizationId,
	});
	return {
		async create(fact: NewMemoryFact): Promise<MemoryFact> {
			const adapter = new OrganizationMemoryAdapter(context.db, {
				organizationId: fact.organizationId,
			});
			const { fact: created } = await recordOrganizationMemoryChange(
				context.db,
				fact,
				actorFor(fact.organizationId),
				{ surface },
				"create",
				fact,
				(provenance) => adapter.create(fact, provenance),
			);
			return created;
		},
		async update(
			fact: MemoryFact,
			updates: FactMutationUpdates,
			operation = "update",
		): Promise<void> {
			const adapter = new OrganizationMemoryAdapter(context.db, {
				organizationId: fact.organizationId,
			});
			await recordOrganizationMemoryChange(
				context.db,
				fact,
				actorFor(fact.organizationId),
				{ surface },
				operation,
				{ factId: fact.id, ...updates },
				async (provenance) => ({
					revision: await adapter.write(
						{
							key: fact.id,
							value: updates.content ?? fact.content,
							provenance,
							review: factReviewState(
								updates.reviewStatus === undefined
									? fact.reviewStatus
									: updates.reviewStatus,
							),
						},
						{ fact, updates },
					),
				}),
			);
		},
	};
}
