import { and, eq } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import {
	osBlueprints,
	osBlueprintRevisions,
	osGadgets,
	osGadgetRevisions,
	osGadgetCode,
	osWorkspaceResources,
} from "../../schema/os-workspaces";

export async function findWorkspaceOutputResource(
	db: DbQueryClient,
	scope: { organizationId: string; workspaceId: string; outputId: string },
) {
	const [row] = await db
		.select()
		.from(osWorkspaceResources)
		.where(
			and(
				eq(osWorkspaceResources.organizationId, scope.organizationId),
				eq(osWorkspaceResources.workspaceId, scope.workspaceId),
				eq(osWorkspaceResources.providerId, "tedix"),
				eq(osWorkspaceResources.resourceType, "output"),
				eq(osWorkspaceResources.providerResourceId, scope.outputId),
				eq(osWorkspaceResources.connectionScope, "tenant"),
			),
		)
		.limit(1);
	return row;
}

export interface InstallWorkspaceAppParams {
	blueprint: typeof osBlueprints.$inferInsert;
	blueprintRevision: typeof osBlueprintRevisions.$inferInsert;
	gadget: typeof osGadgets.$inferInsert;
	revision: typeof osGadgetRevisions.$inferInsert;
	code: typeof osGadgetCode.$inferInsert;
	resource?: typeof osWorkspaceResources.$inferInsert;
}

/** Pin the template, program and capability together; no output body is copied. */
export async function installWorkspaceApp(
	db: DbQueryClient,
	params: InstallWorkspaceAppParams,
) {
	await db.batch([
		db
			.insert(osBlueprints)
			.values(params.blueprint)
			.onConflictDoNothing({ target: osBlueprints.id }),
		db
			.insert(osBlueprintRevisions)
			.values(params.blueprintRevision)
			.onConflictDoNothing({ target: osBlueprintRevisions.id }),
		db
			.insert(osGadgets)
			.values(params.gadget)
			.onConflictDoNothing({ target: osGadgets.id }),
		db
			.insert(osGadgetRevisions)
			.values(params.revision)
			.onConflictDoNothing({ target: osGadgetRevisions.id }),
		db
			.insert(osGadgetCode)
			.values(params.code)
			.onConflictDoNothing({ target: osGadgetCode.revisionId }),
		...(params.resource
			? [
					db
						.insert(osWorkspaceResources)
						.values(params.resource)
						.onConflictDoNothing({ target: osWorkspaceResources.id }),
				]
			: []),
	]);
}
