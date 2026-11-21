import { evaluateCall } from "@tedix/agent-governance/compliance";
import type {
	AccountabilityAdapter,
	Actor,
} from "@tedix/agent-governance/types";
import { guardedCall } from "@tedix/agent-governance/wrap-binding";
import {
	OrganizationMemoryAdapter,
	factReviewState,
	type FactReviewUpdates,
} from "@tedix/db/queries/memory-graph/memory-adapter";
import type { MemoryFact } from "@tedix/db/schema/memory-graph";
import type { DbQueryClient } from "@tedix/db/query-client";
import {
	appendChangeRecord,
	getChangeRecord,
	listChangeRecords,
} from "./organization-log";

/** Called after the review procedure's existing authorization checks. */
export async function storeOrganizationMemoryReview(
	db: DbQueryClient,
	fact: MemoryFact,
	updates: FactReviewUpdates,
	actor: Actor,
): Promise<void> {
	const source = { surface: "memory_graph_review" };
	const changeRecordId = crypto.randomUUID();
	const accountability: AccountabilityAdapter = {
		append: async (record) =>
			Object.freeze(
				await appendChangeRecord(db, fact.organizationId, {
					...record,
					id: changeRecordId,
				}),
			),
		get: (id) => getChangeRecord(db, fact.organizationId, id),
		list: (query) => listChangeRecords(db, fact.organizationId, query ?? {}),
		export: async () => ({
			exportedAt: new Date().toISOString(),
			records: await listChangeRecords(db, fact.organizationId, {}),
		}),
	};
	const adapter = new OrganizationMemoryAdapter(db, {
		organizationId: fact.organizationId,
	});
	await guardedCall(
		{
			actor,
			source,
			resource: `memory:organization:${fact.id}`,
			operation: "review",
			args: { factId: fact.id, ...updates },
			riskTier: "bounded_write",
			blastRadius: "single_resource",
		},
		() =>
			adapter.write(
				{
					key: fact.id,
					value: fact.content,
					provenance: { actor, source, changeRecordId },
					review: factReviewState(updates.reviewStatus ?? fact.reviewStatus),
					reviewedBy: actor.id,
					reviewedAt: new Date().toISOString(),
				},
				{ fact, updates },
			),
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
			after: async (revision) => ({
				revisionId: revision.revisionId,
				hash: revision.hash,
			}),
		},
	);
}
