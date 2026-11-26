import {
	listRowDependents,
	rowDependentsBlocking,
	type RowDependent,
	type RowDependentTargetKind,
} from "@tedix/db/queries/row-dependents";
import type { DbQueryClient } from "@tedix/db/query-client";
import { requireOrgId } from "./org-scope";
import { type BaseContext, createErrorWithData, ErrorCodes } from "./orpc";

/**
 * Refuse to archive, retire or delete a row that something still depends on.
 * Every dependent that would stop working must be named in `acknowledged`
 * for the operation to go on — the same owner override skills use.
 */
export async function assertRowDependentsClear(
	context: BaseContext,
	target: {
		kind: RowDependentTargetKind;
		id: string;
		/** The row's own organization; falls back to the caller's org. */
		orgId?: string | null;
		/** The tedi's current slug, for legacy slug-based org settings. */
		slug?: string | null;
		/** What the row is called in the refusal, e.g. "tedi" or "project". */
		noun: string;
		/** What was attempted, e.g. "archived" or "retired". */
		action: string;
	},
	acknowledged?: readonly string[],
	/**
	 * The store the row's own queries run against; defaults to the request's
	 * D1 session. Core-store surfaces pass `coreQueryDb(context.env)`.
	 */
	db?: DbQueryClient,
): Promise<RowDependent[]> {
	const dependents = await listRowDependents(db ?? context.db, {
		kind: target.kind,
		id: target.id,
		orgId: target.orgId ?? requireOrgId(context),
		slug: target.slug ?? null,
	});
	const blocking = rowDependentsBlocking(dependents, acknowledged);
	if (blocking.length === 0) return dependents;
	throw createErrorWithData(
		ErrorCodes.CONFLICT,
		`This ${target.noun} is still in use, so it was not ${target.action}. ${blocking.map((dependent) => dependent.label).join("; ")}. Stop these uses first, or try again with acknowledgeDependents set to ${JSON.stringify(blocking.map((dependent) => dependent.key))} to confirm they will stop working.`,
		{ code: "ROW_IN_USE", dependents: blocking },
	);
}
