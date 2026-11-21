import { evaluateCall } from "@tedix/agent-governance/compliance";
import type { AccountabilityAdapter } from "@tedix/agent-governance/types";
import { guardedCall } from "@tedix/agent-governance/wrap-binding";
import {
	TediMemoryAdapter,
	tediMemoryKey,
} from "@tedix/db/queries/tedi-memory-adapter";
import type { AppendTediMemoryVersionParams } from "@tedix/db/queries/tedi-memory";
import type { DbQueryClient } from "@tedix/db/query-client";
import {
	appendChangeRecord,
	getChangeRecord,
	listChangeRecords,
} from "./organization-log";

/** Called after the existing memory authorization and content checks. */
export async function storeTediMemoryRevision(
	db: DbQueryClient,
	params: AppendTediMemoryVersionParams,
): Promise<boolean> {
	const actor = {
		id: params.authorId,
		kind: params.authorType === "reflection" ? "tedi" : params.authorType,
		organizationId: params.organizationId,
	};
	const source = {
		surface:
			params.authorType === "reflection"
				? "tedi_memory_reflection"
				: "tedi_memory",
	};
	const changeRecordId = crypto.randomUUID();
	const accountability: AccountabilityAdapter = {
		append: async (record) =>
			Object.freeze(
				await appendChangeRecord(params.organizationId, {
					...record,
					id: changeRecordId,
				}),
			),
		get: (id) => getChangeRecord(params.organizationId, id),
		list: (query) => listChangeRecords(params.organizationId, query ?? {}),
		export: async () => ({
			exportedAt: new Date().toISOString(),
			records: await listChangeRecords(params.organizationId, {}),
		}),
	};
	const adapter = new TediMemoryAdapter(db, params);
	const { result } = await guardedCall(
		{
			actor,
			source,
			resource: `memory:tedi:${params.tediId}:${params.kind}:${params.name}`,
			operation: "write",
			args: {
				sections: params.sections,
				description: params.description,
				content: params.content,
				removed: params.removed,
			},
			riskTier: "bounded_write",
			blastRadius: "single_resource",
		},
		() =>
			adapter.appendDocument(params, {
				key: tediMemoryKey(params.kind, params.name),
				value:
					params.kind === "core"
						? (params.sections ?? {})
						: params.removed
							? null
							: {
									description: params.description ?? "",
									content: params.content ?? "",
								},
				provenance: { actor, source, changeRecordId },
			}),
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
			classify: (revision) =>
				revision
					? { status: "applied" }
					: {
							status: "not_applied",
							error: "Memory document changed concurrently",
						},
			after: async (revision) =>
				revision
					? { revisionId: revision.revisionId, hash: revision.hash }
					: undefined,
		},
	);
	return result !== null;
}
