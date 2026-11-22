import { getOsBlueprintRevision } from "@tedix/db/queries/os-workspaces/blueprints";
import { parseStoredOsBlueprintDefinition } from "@tedix/api-contract/schemas/os-workspaces";
import { installWorkspaceApp } from "./workspace-resource-storage";
import { workLayouts } from "@tedix/api-contract/blueprints/work-layout";
import { AppRuntimeFilesSchema } from "@tedix/api-contract/schemas/os-app-runtime";
import {
	buildWorkView,
	workViewRole,
} from "@tedix/api-contract/assets/work-view-blueprint";
import { appRuntimeCodeLength } from "@tedix/api-contract/utils/app-runtime";
import { initializeWorkspaceDocumentOwner } from "./workspace-document-owner";
import { ORPCError } from "@orpc/server";
import {
	OsBlueprintDefinitionSchema,
	OsGadgetManifestSchema,
} from "@tedix/api-contract/schemas/os-workspaces";
import { instantiateOsBlueprint } from "./os-workspace-outputs";
import {
	createOsGadgetRevision,
	getOsGadgetCode,
	listOsWorkApps,
} from "@tedix/db/queries/os-workspaces/gadgets";
import {
	getOsWorkspace,
	getOsWorkspaceByName,
} from "@tedix/db/queries/os-workspaces/workspaces";
import type { DbQueryClient } from "@tedix/db/query-client";
import type { OsCreatedByKind } from "@tedix/api-contract/schemas/os-workspaces";
import { canonicalDigest } from "../lib/blueprint-digest";
import { getWorkOnboarding } from "@tedix/db/queries/work-onboarding";

async function workId(parts: string[]) {
	const digest = await canonicalDigest(parts);
	return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

/** Install a tenant-owned, pinned blueprint using the ordinary atomic install path. */
export async function installDefaultWorkApps(
	db: DbQueryClient,
	organizationId: string,
	creator: { kind: OsCreatedByKind; id: string },
) {
	// Tenant-scoped deterministic identity makes concurrent creation/onboarding
	// converge without treating an unrelated workspace named Work as ours.
	const workspaceId = await workId(["default-work-apps", organizationId]);
	const scope = { organizationId, workspaceId };
	const existing = await getOsWorkspace(db, scope);
	if (existing) {
		const installed = await listOsWorkApps(
			db,
			organizationId,
			{ userIds: [] },
			201,
			workspaceId,
		);
		if (installed.length > 200)
			throw new ORPCError("CONFLICT", {
				message: "The list of Work apps is incomplete.",
			});
		const rolesHere = new Set<string>();
		for (const { gadget, revision } of installed) {
			const manifest = OsGadgetManifestSchema.parse(
				JSON.parse(revision.manifest),
			);
			if (manifest.navigation?.work) rolesHere.add(manifest.navigation.work);
			const role = workViewRole(manifest);
			const official =
				gadget.sourceBlueprintRevisionId ===
					existing.sourceBlueprintRevisionId ||
				(role && gadget.id === (await workId([workspaceId, role, "gadget"])));
			if (!official) continue;
			const view = buildWorkView(manifest);
			let files: Record<string, string>;
			if (view) {
				files = view.files;
			} else if (role) {
				const code = await getOsGadgetCode(db, {
					organizationId,
					revisionId: revision.id,
				});
				if (!code) continue;
				files = AppRuntimeFilesSchema.parse(JSON.parse(code.files));
				if ("layout.json" in files) continue;
				files["layout.json"] =
					JSON.stringify(workLayouts[role], null, 2) + "\n";
			} else continue;
			const result = await createOsGadgetRevision(db, {
				organizationId,
				gadgetId: gadget.id,
				id: crypto.randomUUID(),
				manifest: JSON.stringify(view?.manifest ?? manifest),
				expectedRevision: revision.revision,
				createdByKind: creator.kind,
				createdById: creator.id,
				code: {
					files: JSON.stringify(files),
					codeLength: appRuntimeCodeLength(files),
				},
			});
			if (!result.ok)
				throw new ORPCError("CONFLICT", {
					message:
						"The Work gadget changed. Open it again to see the latest revision.",
				});
		}
		// Earlier installations omitted a role when a separate workspace already had it.
		if (rolesHere.size < 2 && existing.sourceBlueprintRevisionId) {
			const pinned = await getOsBlueprintRevision(db, {
				organizationId,
				revisionId: existing.sourceBlueprintRevisionId,
			});
			if (pinned)
				for (const app of parseStoredOsBlueprintDefinition(pinned.definition)
					.gadgets) {
					if (app.manifest.navigation?.work)
						rolesHere.add(app.manifest.navigation.work);
				}
		}
		if (rolesHere.size < 2) {
			const config = await getWorkOnboarding(db);
			const definition = OsBlueprintDefinitionSchema.parse(config.definition);
			for (const app of definition.gadgets) {
				const role = app.manifest.navigation?.work;
				if (!role || rolesHere.has(role)) continue;
				const view = buildWorkView(app.manifest);
				if (!view) continue;
				const ids = await Promise.all(
					["blueprint", "template", "gadget", "revision"].map((key) =>
						workId([workspaceId, role, key]),
					),
				);
				const [blueprintId, templateId, gadgetId, id] = ids as [
					string,
					string,
					string,
					string,
				];
				const now = new Date().toISOString();
				const base = {
					organizationId,
					createdByKind: creator.kind,
					createdById: creator.id,
					createdAt: now,
				};
				await installWorkspaceApp(db, {
					templateVersion: 1,
					blueprint: {
						...base,
						id: blueprintId,
						name: app.name,
						status: "published",
						currentRevisionId: templateId,
						updatedAt: now,
					},
					blueprintRevision: {
						...base,
						id: templateId,
						blueprintId,
						definition: JSON.stringify({
							...definition,
							gadgets: [{ ...app, ...view }],
						}),
					},
					gadget: {
						...base,
						id: gadgetId,
						workspaceId,
						name: app.name,
						currentRevisionId: id,
						sourceBlueprintRevisionId: templateId,
						updatedAt: now,
					},
					revision: {
						...base,
						id,
						gadgetId,
						revision: 1,
						manifest: JSON.stringify(view.manifest),
					},
					code: {
						...base,
						revisionId: id,
						gadgetId,
						files: JSON.stringify(view.files),
						codeLength: appRuntimeCodeLength(view.files),
					},
				});
			}
		}
		await initializeWorkspaceDocumentOwner(existing);
		return { workspaceId };
	}
	const configured = await getWorkOnboarding(db).catch((cause: unknown) => {
		throw new ORPCError("SERVICE_UNAVAILABLE", {
			message: "Work app defaults are not configured for this installation",
			cause,
		});
	});
	const definition = OsBlueprintDefinitionSchema.parse(configured.definition);
	definition.gadgets = definition.gadgets.map((app) => ({
		...app,
		...(app.files ? {} : buildWorkView(app.manifest)),
	}));
	const now = new Date().toISOString();
	const base = {
		organizationId,
		createdByKind: creator.kind,
		createdById: creator.id,
		createdAt: now,
	};
	const blueprintId = crypto.randomUUID();
	const revisionId = crypto.randomUUID();
	const name = (await getOsWorkspaceByName(db, {
		organizationId,
		name: "Work",
	}))
		? `Work apps ${workspaceId.slice(0, 8)}`
		: "Work";
	const gadgets = definition.gadgets.map((declared) => ({
		...base,
		id: crypto.randomUUID(),
		workspaceId,
		name: declared.name,
		status: "active" as const,
		currentRevisionId: crypto.randomUUID(),
		sourceBlueprintRevisionId: revisionId,
		updatedAt: now,
	}));
	try {
		await instantiateOsBlueprint(db, {
			blueprintCopy: {
				blueprint: {
					...base,
					id: blueprintId,
					name: `Work apps ${workspaceId.slice(0, 8)}`,
					status: "published",
					currentRevisionId: revisionId,
					updatedAt: now,
				},
				revision: {
					...base,
					id: revisionId,
					blueprintId,
					revision: 1,
					definition: JSON.stringify(definition),
				},
			},
			workspace: {
				...base,
				id: workspaceId,
				name,
				status: "active",
				visibility: "org",
				sourceBlueprintId: blueprintId,
				sourceBlueprintRevisionId: revisionId,
				sourceBlueprintRevisionNumber: 1,
				updatedAt: now,
				instantiationPreflight: JSON.stringify({
					blueprintId,
					revisionId,
					revision: 1,
					status: "not_configured",
					instantiateAllowed: true,
					targetTediId: null,
					requirements: null,
					decisions: [],
					blockingReasons: [],
					consentReasons: [],
					configurationReasons: [],
					resolvedAt: now,
				}),
			},
			gadgets,
			code: gadgets.flatMap((gadget, index) => {
				const files = definition.gadgets[index]!.files;
				return files
					? [
							{
								...base,
								revisionId: gadget.currentRevisionId,
								gadgetId: gadget.id,
								files: JSON.stringify(files),
								codeLength: appRuntimeCodeLength(files),
							},
						]
					: [];
			}),
			revisions: gadgets.map((gadget, index) => ({
				...base,
				id: gadget.currentRevisionId,
				gadgetId: gadget.id,
				revision: 1,
				manifest: JSON.stringify(definition.gadgets[index]!.manifest),
			})),
		});
	} catch (error) {
		// Only adopt a winner at our exact tenant-scoped identity. Other failed
		// batches must remain failures so onboarding can be retried truthfully.
		const winner = await getOsWorkspace(db, scope);
		if (!winner) throw error;
		await initializeWorkspaceDocumentOwner(winner);
	}
	return { workspaceId };
}
