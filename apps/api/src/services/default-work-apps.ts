import {
	OsBlueprintDefinitionSchema,
	OsGadgetManifestSchema,
} from "@tedix/api-contract/schemas/os-workspaces";
import { instantiateOsBlueprint } from "@tedix/db/queries/os-workspaces/instantiate";
import { listOsWorkApps } from "@tedix/db/queries/os-workspaces/gadgets";
import {
	getOsWorkspace,
	getOsWorkspaceByName,
} from "@tedix/db/queries/os-workspaces/workspaces";
import type { DbQueryClient } from "@tedix/db/query-client";
import type { OsCreatedByKind } from "@tedix/api-contract/schemas/os-workspaces";
import { canonicalDigest } from "../lib/blueprint-digest";
import definitionData from "./default-work-blueprint.json";

/** Install a tenant-owned, pinned blueprint using the ordinary atomic install path. */
export async function installDefaultWorkApps(
	db: DbQueryClient,
	organizationId: string,
	creator: { kind: OsCreatedByKind; id: string },
) {
	// Tenant-scoped deterministic identity makes concurrent creation/onboarding
	// converge without treating an unrelated workspace named Work as ours.
	const digest = await canonicalDigest(["default-work-apps", organizationId]);
	const workspaceId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
	const scope = { organizationId, workspaceId };
	const existing = await getOsWorkspace(db, scope);
	if (existing) return { workspaceId: existing.id };

	const installed = await listOsWorkApps(
		db,
		organizationId,
		{ userIds: [] },
		200,
	);
	const roles = new Set(
		installed.map((row) => {
			const manifest = OsGadgetManifestSchema.parse(
				JSON.parse(row.revision.manifest),
			);
			return manifest.navigation?.work;
		}),
	);
	if (roles.has("feed") && roles.has("deck"))
		return { workspaceId: installed[0]!.gadget.workspaceId };

	const definition = OsBlueprintDefinitionSchema.parse(definitionData);
	definition.gadgets = definition.gadgets.filter(
		(app) => !roles.has(app.manifest.navigation?.work),
	);
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
		if (!(await getOsWorkspace(db, scope))) throw error;
	}
	return { workspaceId };
}
