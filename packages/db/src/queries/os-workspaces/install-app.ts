import { osGadgetHasWorkNavigation } from "./gadget-navigation";
import { and, desc, eq, getColumns, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { coreTable } from "../../core-store/client";
import { coreStore, jsonRead, jsonWrite } from "../../core-store/dialect";
import { osGadgetHasRuntimeTriggers } from "./gadget-triggers";
import {
	osBlueprints as d1OsBlueprints,
	osBlueprintRevisions as d1OsBlueprintRevisions,
	osGadgets as d1OsGadgets,
	osGadgetRevisions as d1OsGadgetRevisions,
	osGadgetCode as d1OsGadgetCode,
	osWorkspaceResources as d1OsWorkspaceResources,
} from "../../schema/os-workspaces";
import {
	buildEnsureOsGadgetCodeBlobStatement,
	splitOsGadgetCodeRow,
} from "./gadget-code";

export async function findWorkspaceOutputResource(
	db: DbQueryClient,
	scope: { organizationId: string; workspaceId: string; outputId: string },
) {
	const osWorkspaceResources = coreTable(db, d1OsWorkspaceResources);
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
	blueprint: typeof d1OsBlueprints.$inferInsert;
	blueprintRevision: Omit<
		typeof d1OsBlueprintRevisions.$inferInsert,
		"revision"
	>;
	templateVersion: number;
	gadget: typeof d1OsGadgets.$inferInsert;
	revision: typeof d1OsGadgetRevisions.$inferInsert;
	code: typeof d1OsGadgetCode.$inferInsert;
	resource?: typeof d1OsWorkspaceResources.$inferInsert;
}

type WorkspaceAppTemplate = Pick<
	InstallWorkspaceAppParams,
	"blueprint" | "blueprintRevision" | "templateVersion"
>;

function templateStatements(db: DbQueryClient, params: WorkspaceAppTemplate) {
	const osBlueprints = coreTable(db, d1OsBlueprints);
	const osBlueprintRevisions = coreTable(db, d1OsBlueprintRevisions);
	const revision = params.blueprintRevision;
	const sequence = sql<number>`coalesce((select max(${osBlueprintRevisions.revision}) from ${osBlueprintRevisions} where ${osBlueprintRevisions.blueprintId} = ${revision.blueprintId}), 0) + 1`;
	// Bundled versions and user-authored revisions share history, not a sequence.
	const bundledVersion =
		coreStore(db) === "postgres"
			? sql`case when jsonb_typeof(${osBlueprintRevisions.definition}::jsonb #> '{gadgets,0,manifest,config,settings,blueprintVersion}') = 'number'
			and (${osBlueprintRevisions.definition}::jsonb #>> '{gadgets,0,manifest,config,settings,blueprintVersion}') ~ '^-?[0-9]+$'
			then (${osBlueprintRevisions.definition}::jsonb #>> '{gadgets,0,manifest,config,settings,blueprintVersion}')::numeric else 1 end`
			: sql`case when json_type(${osBlueprintRevisions.definition}, '$.gadgets[0].manifest.config.settings.blueprintVersion') = 'integer' then json_extract(${osBlueprintRevisions.definition}, '$.gadgets[0].manifest.config.settings.blueprintVersion') else 1 end`;
	const priorBundleVersion = sql<number>`coalesce((select max(${bundledVersion}) from ${osBlueprintRevisions} where ${osBlueprintRevisions.organizationId} = ${revision.organizationId} and ${osBlueprintRevisions.blueprintId} = ${revision.blueprintId} and ${osBlueprintRevisions.id} <> ${revision.id}), 0)`;
	const lockQuery = db
		.select({ id: osBlueprints.id })
		.from(osBlueprints)
		.where(
			and(
				eq(osBlueprints.id, revision.blueprintId),
				eq(osBlueprints.organizationId, revision.organizationId),
			),
		);
	return [
		db
			.insert(osBlueprints)
			.values(params.blueprint)
			.onConflictDoNothing({ target: osBlueprints.id }),
		...(coreStore(db) === "postgres"
			? [
					(
						lockQuery as typeof lockQuery & {
							for(strength: "update"): typeof lockQuery;
						}
					).for("update"),
				]
			: []),
		db
			.insert(osBlueprintRevisions)
			.select(
				db
					.select({
						id: sql<string>`${revision.id}`.as("id"),
						organizationId: sql<string>`${revision.organizationId}`.as(
							"organization_id",
						),
						blueprintId: sql<string>`${revision.blueprintId}`.as(
							"blueprint_id",
						),
						revision: sequence.as("revision"),
						definition: sql<string>`${revision.definition}`.as("definition"),
						createdByKind: sql<string>`${revision.createdByKind}`.as(
							"created_by_kind",
						),
						createdById: sql<string>`${revision.createdById}`.as(
							"created_by_id",
						),
						createdAt:
							sql<string>`${revision.createdAt ?? new Date().toISOString()}`.as(
								"created_at",
							),
						publishedAt: sql<string | null>`${revision.publishedAt ?? null}`.as(
							"published_at",
						),
					})
					.from(osBlueprints)
					.where(
						and(
							eq(osBlueprints.id, revision.blueprintId),
							eq(osBlueprints.organizationId, revision.organizationId),
						),
					),
			)
			.onConflictDoNothing({ target: osBlueprintRevisions.id }),
		db
			.update(osBlueprints)
			.set({
				currentRevisionId: revision.id,
				updatedAt: params.blueprint.updatedAt,
			})
			.where(
				and(
					eq(osBlueprints.organizationId, params.blueprint.organizationId),
					eq(osBlueprints.id, params.blueprint.id),
					sql`${priorBundleVersion} < ${params.templateVersion}`,
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
		expectedSlot: string;
		expectedGadgetRevisionId: string;
		gadgetId: string;
		kind: string;
		now: string;
	},
) {
	const osWorkspaceResources = coreTable(db, d1OsWorkspaceResources);
	const osGadgets = coreTable(db, d1OsGadgets);
	const [row] = await db
		.update(osWorkspaceResources)
		.set({
			metadata: jsonWrite(
				db,
				jsonWrite(
					db,
					sql`${osWorkspaceResources.metadata}${coreStore(db) === "postgres" ? sql`::jsonb` : sql``}`,
					["gadgetId"],
					params.gadgetId,
				),
				["kind"],
				params.kind,
			),
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
				eq(osWorkspaceResources.slot, params.expectedSlot),
				eq(osWorkspaceResources.connectionScope, "tenant"),
				eq(osWorkspaceResources.status, "active"),
				sql`exists (select 1 from ${osGadgets} where ${osGadgets.organizationId} = ${params.organizationId} and ${osGadgets.workspaceId} = ${params.workspaceId} and ${osGadgets.id} = ${params.gadgetId} and ${osGadgets.currentRevisionId} = ${params.expectedGadgetRevisionId} and ${osGadgets.status} = 'active')`,
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
	const osGadgets = coreTable(db, d1OsGadgets);
	const osBlueprintRevisions = coreTable(db, d1OsBlueprintRevisions);
	const osGadgetRevisions = coreTable(db, d1OsGadgetRevisions);
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
				sql`${jsonRead(db, sql`${osGadgetRevisions.manifest}${coreStore(db) === "postgres" ? sql`::jsonb` : sql``}`, ["config", "settings", "slot"])} = ${scope.slot}`,
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
	const osGadgets = coreTable(db, d1OsGadgets);
	const osGadgetRevisions = coreTable(db, d1OsGadgetRevisions);
	const osGadgetCode = coreTable(db, d1OsGadgetCode);
	const osWorkspaceResources = coreTable(db, d1OsWorkspaceResources);
	const { blob, code } = await splitOsGadgetCodeRow(params.code);
	await db.batch([
		...templateStatements(db, params),
		db
			.insert(osGadgets)
			.values({
				...params.gadget,
				hasRuntimeTriggers: osGadgetHasRuntimeTriggers(
					params.revision.manifest,
				),
				hasWorkNavigation: osGadgetHasWorkNavigation(params.revision.manifest),
			})
			.onConflictDoNothing({ target: osGadgets.id }),
		db
			.insert(osGadgetRevisions)
			.values(params.revision)
			.onConflictDoNothing({ target: osGadgetRevisions.id }),
		// The files are stored once per content; this install adds a pointer.
		buildEnsureOsGadgetCodeBlobStatement(db, blob),
		db
			.insert(osGadgetCode)
			.values(code)
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
