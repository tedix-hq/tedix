import { implement } from "@orpc/server";
import { osGadgetStateContract } from "@tedix/api-contract/contracts/os-gadget-state";
import {
	OsGadgetStateRecordSchema,
	OsGadgetStateMutationResultSchema,
} from "@tedix/api-contract/schemas/os-gadget-state";
import {
	getGadgetState,
	listGadgetState,
	mutateGadgetState,
} from "@tedix/db/queries/os-workspaces/gadget-state";
import type { OsGadgetStateRow } from "@tedix/db/schema/os-gadget-state";
import { createDbQueryClient } from "@tedix/db/query-client";
import {
	AUTHZ,
	type BaseContext,
	withAuth,
	createError,
	ErrorCodes,
} from "../orpc";
import {
	authorizeGadgetState,
	authorizeGadgetStateSources,
	mergeGadgetStateSources,
} from "../../services/os-gadget-state-authority";
import { canonicalDigest } from "../../lib/blueprint-digest";
const os = implement(osGadgetStateContract).$context<BaseContext>();
const authed = os.use(withAuth);
const read = authed.use(AUTHZ.osRead);
const write = authed.use(AUTHZ.osRun);
function project(row: OsGadgetStateRow) {
	return OsGadgetStateRecordSchema.parse({
		key: row.key,
		revision: row.revision,
		value: row.value === null ? null : JSON.parse(row.value),
		deleted: row.deleted,
		accessEnvelope: JSON.parse(row.accessEnvelope),
		executionId: row.executionId,
		updatedAt: row.updatedAt,
	});
}
const get = read.get.handler(async ({ context, input }) => {
	const { scope } = await authorizeGadgetState(context, input, false);
	const row = await getGadgetState(
		createDbQueryClient(context.env.DB),
		scope,
		input.key,
	);
	if (row)
		await authorizeGadgetStateSources(
			context,
			scope.organizationId,
			row.accessEnvelope,
		);
	return { record: row ? project(row) : null };
});
const list = read.list.handler(async ({ context, input }) => {
	const { scope } = await authorizeGadgetState(context, input, false);
	const rows = await listGadgetState(
		createDbQueryClient(context.env.DB),
		scope,
		{ ...input, limit: input.limit + 1 },
	);
	const visible = rows.slice(0, input.limit);
	for (const row of rows)
		await authorizeGadgetStateSources(
			context,
			scope.organizationId,
			row.accessEnvelope,
		);
	return {
		items: visible.map(project),
		nextAfter: rows.length > input.limit ? visible.at(-1)!.key : null,
	};
});
async function mutate(
	context: BaseContext,
	input: {
		workspaceId: string;
		gadgetId: string;
		execution?: { executionId: string; executionEpoch: number };
		key: string;
		expectedRevision: number;
		idempotencyKey: string;
		value?: unknown;
	},
	deleted: boolean,
) {
	const { scope, fence, accessEnvelope } = await authorizeGadgetState(
		context,
		input,
		true,
	);
	if (!fence)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"A live Gadget execution is required",
		);
	const db = createDbQueryClient(context.env.DB);
	const old = await getGadgetState(db, scope, input.key);
	if (old)
		await authorizeGadgetStateSources(
			context,
			scope.organizationId,
			old.accessEnvelope,
		);
	const merged = mergeGadgetStateSources(
		old?.accessEnvelope ?? null,
		accessEnvelope,
	);
	const digest = await canonicalDigest({ ...input, deleted });
	const receipt = await mutateGadgetState(db, {
		...fence,
		key: input.key,
		expectedRevision: input.expectedRevision,
		idempotencyKey: input.idempotencyKey,
		digest,
		value: deleted ? null : JSON.stringify(input.value),
		deleted,
		accessEnvelope: JSON.stringify(merged),
		now: new Date().toISOString(),
	});
	if (receipt.digest !== digest)
		throw createError(
			ErrorCodes.CONFLICT,
			"Idempotency key already belongs to a different Gadget state mutation",
		);
	const record = receipt.result
		? OsGadgetStateRecordSchema.parse(JSON.parse(receipt.result))
		: null;
	if (record)
		await authorizeGadgetStateSources(
			context,
			scope.organizationId,
			JSON.stringify(record.accessEnvelope),
		);
	return OsGadgetStateMutationResultSchema.parse({
		outcome: receipt.status,
		record,
	});
}
const put = write.put.handler(({ context, input }) =>
	mutate(context, input, false),
);
const remove = write.delete.handler(({ context, input }) =>
	mutate(context, input, true),
);
/** Canonical state router; registry and MCP projection are owned by the product host. */
export const osGadgetStateContractRouter = os.router({
	get,
	list,
	put,
	delete: remove,
});
