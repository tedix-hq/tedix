import { implement } from "@orpc/server";
import { osWorkspacesContract } from "@tedix/api-contract/contracts/os-workspaces";
import {
	OsBlueprintDefinitionSchema,
	OsGadgetManifestSchema,
	parseStoredOsBlueprintDefinition,
} from "@tedix/api-contract/schemas/os-workspaces";
import { AppRuntimeFilesSchema } from "@tedix/api-contract/schemas/os-app-runtime";
import { isAppRuntimeManifest } from "@tedix/api-contract/utils/app-runtime";
import {
	getOsBlueprintRevision,
	importOsBlueprint,
} from "@tedix/db/queries/os-workspaces/blueprints";
import {
	getOsGadgetCode,
	getOsGadgetRevision,
	listOsGadgets,
} from "@tedix/db/queries/os-workspaces/gadgets";
import { listOsWorkspaceResources } from "@tedix/db/queries/os-workspaces/resources";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
} from "../orpc";
import { OS_WORKSPACES_AUDIT, osAudit } from "../os-audit";
import {
	mapBlueprint,
	mapBlueprintRevision,
	queryDb,
	requireWorkspace,
	resolveCreator,
	rethrowNameConflict,
} from "./os-workspaces-shared";

const os = implement(osWorkspacesContract).$context<BaseContext>();

export const saveWorkspaceBlueprint = os
	.use(withAuth)
	.use(osAudit(OS_WORKSPACES_AUDIT))
	.use(AUTHZ.osAuthor)
	.blueprints.saveWorkspace.handler(async ({ context, input }) => {
		const workspace = await requireWorkspace(context, input.workspaceId);
		const db = queryDb(context);
		const organizationId = workspace.organizationId;
		const [apps, resources, source] = await Promise.all([
			listOsGadgets(db, organizationId, {
				workspaceId: workspace.id,
				status: "active",
				limit: 101,
			}),
			listOsWorkspaceResources(db, {
				organizationId,
				workspaceId: workspace.id,
				status: "active",
				limit: 26,
			}),
			workspace.sourceBlueprintRevisionId
				? getOsBlueprintRevision(db, {
						organizationId,
						revisionId: workspace.sourceBlueprintRevisionId,
					})
				: undefined,
		]);
		if (apps.length > 100 || resources.length > 25)
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Workspace exceeds the blueprint limit of 100 apps or 25 resource slots",
			);
		const gadgets = await Promise.all(
			apps.map(async (app) => {
				const revision = app.currentRevisionId
					? await getOsGadgetRevision(db, {
							organizationId,
							revisionId: app.currentRevisionId,
						})
					: undefined;
				if (!revision || revision.gadgetId !== app.id)
					throw createError(
						ErrorCodes.BAD_REQUEST,
						`Commit a revision of ${app.name} before saving a blueprint`,
					);
				const manifest = OsGadgetManifestSchema.parse(
					JSON.parse(revision.manifest),
				);
				if (!isAppRuntimeManifest(manifest))
					return { name: app.name, manifest };
				const code = await getOsGadgetCode(db, {
					organizationId,
					revisionId: revision.id,
				});
				if (!code || code.gadgetId !== app.id)
					throw createError(
						ErrorCodes.BAD_REQUEST,
						`Runtime app ${app.name} has no source files at its current revision`,
					);
				return {
					name: app.name,
					manifest,
					files: AppRuntimeFilesSchema.parse(JSON.parse(code.files)),
				};
			}),
		);
		const inherited = source
			? parseStoredOsBlueprintDefinition(source.definition).requirements
			: null;
		const slots = new Map(
			(inherited?.resources ?? []).map((slot) => [slot.slot, slot]),
		);
		const outputSlots = new Set(
			(inherited?.outputs ?? []).map(
				(output, index) => output.slot ?? `output_${index + 1}`,
			),
		);
		for (const resource of resources) {
			if (!resource.slot || outputSlots.has(resource.slot)) continue;
			// Keep the shape only: no selected account, resource id, metadata or source name.
			slots.set(resource.slot, {
				slot: resource.slot,
				providerId: resource.providerId,
				tokenScope: resource.connectionScope,
				scopes: JSON.parse(resource.requiredScopes ?? "[]"),
				resourceType: resource.resourceType,
				label: resource.slot,
			});
		}
		for (const app of gadgets)
			for (const grant of app.manifest.resourceGrants ?? [])
				if (!slots.has(grant.slot) && !outputSlots.has(grant.slot))
					throw createError(
						ErrorCodes.BAD_REQUEST,
						`Resource slot ${grant.slot} needs a resource shape before saving`,
					);
		const definition = OsBlueprintDefinitionSchema.parse({
			gadgets,
			requirements: {
				version: 1,
				...inherited,
				resources: [...slots.values()],
			},
		});
		const creator = resolveCreator(context);
		const now = new Date().toISOString();
		const id = crypto.randomUUID(),
			revisionId = crypto.randomUUID();
		const accountability = {
			organizationId,
			createdByKind: creator.kind,
			createdById: creator.id,
			createdAt: now,
		};
		try {
			const saved = await importOsBlueprint(db, {
				blueprint: {
					...accountability,
					id,
					name: input.name,
					description: input.description ?? null,
					status: "draft",
					visibility: "org",
					currentRevisionId: revisionId,
					updatedAt: now,
				},
				revision: {
					...accountability,
					id: revisionId,
					blueprintId: id,
					revision: 1,
					definition: JSON.stringify(definition),
				},
			});
			return {
				blueprint: mapBlueprint(saved.blueprint),
				revision: mapBlueprintRevision(saved.revision),
			};
		} catch (error) {
			return rethrowNameConflict(
				error,
				"A blueprint with this name already exists",
			);
		}
	});
