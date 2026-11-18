import { and, eq } from "drizzle-orm";
import { type TenantScope, normalizeTenantScope } from "@tedix/db/tenant-scope";
import type { DbQueryClient } from "@tedix/db/query-client";
import {
	type NewOsOutputRow,
	type NewOsOutputRevisionRow,
	type OsOutputRow,
	type OsOutputRevisionRow,
	osOutputs,
	osOutputRevisions,
} from "@tedix/db/schema/os-workspaces";

type OsOutputScopeParams = TenantScope & { outputId: string };

export async function createOsOutput(
	db: DbQueryClient,
	tenantScope: TenantScope,
	output: NewOsOutputRow,
	revision: NewOsOutputRevisionRow,
): Promise<{ output: OsOutputRow; revision: OsOutputRevisionRow }> {
	const { organizationId, workspaceId } = normalizeTenantScope(tenantScope);
	if (
		output.organizationId !== organizationId ||
		revision.organizationId !== organizationId ||
		(workspaceId !== undefined && output.workspaceId !== workspaceId)
	) {
		throw new Error("Output and revision must belong to the tenant scope");
	}
	const [outputRows, revisionRows] = await db.batch([
		db.insert(osOutputs).values(output).returning(),
		db.insert(osOutputRevisions).values(revision).returning(),
	]);
	const outputRow = outputRows[0];
	const revisionRow = revisionRows[0];
	if (!outputRow || !revisionRow) {
		throw new Error("OS output insert returned no row");
	}
	return { output: outputRow, revision: revisionRow };
}

export async function getOsOutput(
	db: DbQueryClient,
	params: OsOutputScopeParams,
): Promise<OsOutputRow | undefined> {
	params = { ...params, ...normalizeTenantScope(params) };
	const [row] = await db
		.select()
		.from(osOutputs)
		.where(
			and(
				eq(osOutputs.organizationId, params.organizationId),
				eq(osOutputs.id, params.outputId),
			),
		)
		.limit(1);
	return row;
}

export async function getOsOutputRevision(
	db: DbQueryClient,
	params: { organizationId: string; revisionId: string } & TenantScope,
): Promise<OsOutputRevisionRow | undefined> {
	params = { ...params, ...normalizeTenantScope(params) };
	const [row] = await db
		.select()
		.from(osOutputRevisions)
		.where(
			and(
				eq(osOutputRevisions.organizationId, params.organizationId),
				eq(osOutputRevisions.id, params.revisionId),
			),
		)
		.limit(1);
	return row;
}
