import { and, desc, eq, getColumns, sql } from "drizzle-orm";
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

type WorkspaceAppTemplate = Pick<
	InstallWorkspaceAppParams,
	"blueprint" | "blueprintRevision"
>;

function templateStatements(db: DbQueryClient, params: WorkspaceAppTemplate) {
	return [
		db.insert(osBlueprints).values(params.blueprint).onConflictDoNothing({
			target: osBlueprints.id,
		}),
		db
			.insert(osBlueprintRevisions)
			.values(params.blueprintRevision)
			.onConflictDoNothing({ target: osBlueprintRevisions.id }),
		db
			.update(osBlueprints)
			.set({
				currentRevisionId: params.blueprintRevision.id,
				updatedAt: params.blueprint.updatedAt,
			})
			.where(
				and(
					eq(osBlueprints.organizationId, params.blueprint.organizationId),
					eq(osBlueprints.id, params.blueprint.id),
					sql`coalesce((select ${osBlueprintRevisions.revision} from ${osBlueprintRevisions} where ${osBlueprintRevisions.id} = ${osBlueprints.currentRevisionId}), 0) < ${params.blueprintRevision.revision}`,
				),
			),
	] as const;
}

export async function publishWorkspaceAppTemplate(
	db: DbQueryClient,
	params: WorkspaceAppTemplate,
) {
	await db.batch(templateStatements(db, params));
}

export async function linkWorkspaceOutputEditor(
	db: DbQueryClient,
	params: {
		organizationId: string;
		workspaceId: string;
		resourceId: string;
		outputId: string;
		gadgetId: string;
		kind: string;
		now: string;
	},
) {
	const [row] = await db
		.update(osWorkspaceResources)
		.set({
			metadata: sql`json_set(coalesce(${osWorkspaceResources.metadata}, '{}'), '$.gadgetId', ${params.gadgetId}, '$.kind', ${params.kind})`,
			updatedAt: params.now,
		})
		.where(
			and(
				eq(osWorkspaceResources.organizationId, params.organizationId),
				eq(osWorkspaceResources.workspaceId, params.workspaceId),
				eq(osWorkspaceResources.id, params.resourceId),
				eq(osWorkspaceResources.providerId, "tedix"),
				eq(osWorkspaceResources.resourceType, "output"),
				eq(osWorkspaceResources.providerResourceId, params.outputId),
				eq(osWorkspaceResources.status, "active"),
			),
		)
		.returning({ id: osWorkspaceResources.id });
	return row;
}

export async function findWorkspaceOutputEditor(
	db: DbQueryClient,
	scope: {
		organizationId: string;
		workspaceId: string;
		blueprintId: string;
		slot: string;
	},
) {
	const [row] = await db
		.select(getColumns(osGadgets))
		.from(osGadgets)
		.innerJoin(
			osBlueprintRevisions,
			eq(osBlueprintRevisions.id, osGadgets.sourceBlueprintRevisionId),
		)
		.innerJoin(
			osGadgetRevisions,
			eq(osGadgetRevisions.id, osGadgets.currentRevisionId),
		)
		.where(
			and(
				eq(osGadgets.organizationId, scope.organizationId),
				eq(osGadgets.workspaceId, scope.workspaceId),
				eq(osBlueprintRevisions.blueprintId, scope.blueprintId),
				sql`json_extract(${osGadgetRevisions.manifest}, '$.config.settings.slot') = ${scope.slot}`,
			),
		)
		.orderBy(desc(osGadgets.updatedAt), osGadgets.id)
		.limit(1);
	return row;
}

/** Pin the template, program and capability together; no output body is copied. */
export async function installWorkspaceApp(
	db: DbQueryClient,
	params: InstallWorkspaceAppParams,
) {
	await db.batch([
		...templateStatements(db, params),
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
