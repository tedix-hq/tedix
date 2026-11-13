/** Local fixture handlers: Blueprint procedures. */

import type { OsBlueprintWithVisibility as OsBlueprint } from "@tedix/api-contract/contracts/os-workspaces";
import type {
	OsBlueprintPreflight,
	OsBlueprintExport,
	OsBlueprintRevision,
	OsGadget,
	OsGadgetRevision,
	OsWorkspace,
	OsWorkspaceResource,
} from "@tedix/api-contract/schemas/os-workspaces";
import {
	APP_RUNTIME_ENTRY,
	nextId,
	now,
	ORG_ID,
	revisionConflict,
	RpcError,
} from "./core";
import {
	findBlueprint,
	findWorkspace,
	latestRevision,
	localGalleryPage,
} from "./lookups";
import { state } from "./state";

export const blueprintHandlers: Record<string, (input: never) => unknown> = {
	"osWorkspaces/blueprints/list": (
		input: { status?: OsBlueprint["status"] } | undefined,
	) => ({
		items: state.blueprints.filter(
			(row) => input?.status === undefined || row.status === input.status,
		),
		truncated: false,
	}),
	"osWorkspaces/blueprints/gallery": (input: { limit: number }) => ({
		items: state.blueprints
			.filter(
				(row) => row.status === "published" && row.visibility === "catalog",
			)
			.slice(0, input.limit)
			.map((blueprint) => {
				const revision = latestRevision(
					state.blueprintRevisions.filter(
						(row) => row.blueprintId === blueprint.id,
					),
				);
				return {
					id: blueprint.id,
					name: blueprint.name,
					description: blueprint.description,
					gadgetCount: revision?.definition.gadgets.length ?? 0,
					organizationName: "Tedix local",
					publishedAt: revision?.publishedAt ?? null,
					featured: state.featuredBlueprintIds.includes(blueprint.id),
				};
			}),
	}),
	"osWorkspaces/blueprints/galleryPage": (input: { blueprintId: string }) => ({
		blueprint: localGalleryPage(input.blueprintId),
	}),
	"osWorkspaces/blueprints/setFeatured": (input: {
		blueprintId: string;
		featured: boolean;
	}) => {
		const page = localGalleryPage(input.blueprintId);
		state.featuredBlueprintIds = state.featuredBlueprintIds.filter(
			(id) => id !== input.blueprintId,
		);
		if (input.featured) state.featuredBlueprintIds.push(input.blueprintId);
		return {
			item: {
				id: page.id,
				name: page.name,
				description: page.description,
				gadgetCount: page.apps.length,
				organizationName: page.organizationName,
				publishedAt: page.publishedAt,
				featured: input.featured,
			},
		};
	},
	"osWorkspaces/blueprints/saveWorkspace": (input: {
		workspaceId: string;
		name: string;
		description?: string;
	}) => {
		findWorkspace(input.workspaceId);
		if (state.blueprints.some((row) => row.name === input.name)) {
			throw new RpcError(
				"CONFLICT",
				"A blueprint with this name already exists",
			);
		}
		const gadgets = state.gadgets
			.filter(
				(row) =>
					row.workspaceId === input.workspaceId && row.status === "active",
			)
			.map((gadget) => {
				const revision = state.gadgetRevisions.find(
					(row) => row.id === gadget.currentRevisionId,
				);
				if (!revision)
					throw new RpcError(
						"BAD_REQUEST",
						`Commit a revision of ${gadget.name} before saving a blueprint`,
					);
				const files = state.gadgetCode[revision.id];
				if (revision.manifest.entry === APP_RUNTIME_ENTRY && !files) {
					throw new RpcError(
						"BAD_REQUEST",
						`Runtime app ${gadget.name} has no source files at its current revision`,
					);
				}
				return structuredClone({
					name: gadget.name,
					manifest: revision.manifest,
					...(files ? { files } : {}),
				});
			});
		const createdAt = now();
		const revisionId = nextId();
		const blueprint: OsBlueprint = {
			id: nextId(),
			organizationId: ORG_ID,
			name: input.name,
			description: input.description ?? null,
			status: "draft",
			visibility: "org",
			currentRevisionId: revisionId,
			lineage: null,
			createdByKind: "user",
			createdById: "dev-operator",
			createdAt,
			updatedAt: createdAt,
		};
		const revision: OsBlueprintRevision = {
			id: revisionId,
			organizationId: ORG_ID,
			blueprintId: blueprint.id,
			revision: 1,
			definition: { gadgets, requirements: null },
			createdByKind: "user",
			createdById: "dev-operator",
			createdAt,
			publishedAt: null,
		};
		state.blueprints.push(blueprint);
		state.blueprintRevisions.push(revision);
		return { blueprint, revision };
	},
	"osWorkspaces/blueprints/create": (input: {
		name: string;
		description?: string;
	}) => {
		const blueprint: OsBlueprint = {
			id: nextId(),
			organizationId: ORG_ID,
			name: input.name,
			description: input.description ?? null,
			status: "draft",
			visibility: "org",
			currentRevisionId: null,
			lineage: null,
			createdByKind: "user",
			createdById: "dev-operator",
			createdAt: now(),
			updatedAt: now(),
		};
		state.blueprints.push(blueprint);
		return { blueprint };
	},
	"osWorkspaces/blueprints/get": (input: { blueprintId: string }) => {
		const blueprint = findBlueprint(input.blueprintId);
		const currentRevision = latestRevision(
			state.blueprintRevisions.filter(
				(row) => row.blueprintId === blueprint.id,
			),
		);
		return { blueprint, currentRevision };
	},
	"osWorkspaces/blueprints/revise": (input: {
		blueprintId: string;
		definition: OsBlueprintRevision["definition"];
		expectedRevision?: number;
	}) => {
		const blueprint = findBlueprint(input.blueprintId);
		const current = latestRevision(
			state.blueprintRevisions.filter(
				(row) => row.blueprintId === blueprint.id,
			),
		);
		const currentNumber = current?.revision ?? 0;
		if (
			input.expectedRevision !== undefined &&
			input.expectedRevision !== currentNumber
		) {
			throw revisionConflict(input.expectedRevision, current?.revision ?? null);
		}
		const revision: OsBlueprintRevision = {
			id: nextId(),
			organizationId: ORG_ID,
			blueprintId: blueprint.id,
			revision: currentNumber + 1,
			definition: {
				gadgets: input.definition.gadgets ?? [],
				requirements: input.definition.requirements ?? null,
			},
			createdByKind: "user",
			createdById: "dev-operator",
			createdAt: now(),
			publishedAt: null,
		};
		state.blueprintRevisions.push(revision);
		blueprint.currentRevisionId = revision.id;
		blueprint.updatedAt = revision.createdAt;
		return { blueprint, revision };
	},
	"osWorkspaces/blueprints/publish": (input: { blueprintId: string }) => {
		const blueprint = findBlueprint(input.blueprintId);
		const revision = latestRevision(
			state.blueprintRevisions.filter(
				(row) => row.blueprintId === blueprint.id,
			),
		);
		if (!revision) {
			throw new RpcError("BAD_REQUEST", "Blueprint has no revision to publish");
		}
		blueprint.status = "published";
		blueprint.updatedAt = now();
		revision.publishedAt = blueprint.updatedAt;
		return { blueprint, revision };
	},
	"osWorkspaces/blueprints/setVisibility": (input: {
		blueprintId: string;
		visibility: OsBlueprint["visibility"];
	}) => {
		const blueprint = findBlueprint(input.blueprintId);
		if (blueprint.status !== "published") {
			throw new RpcError(
				"BAD_REQUEST",
				"Only a published blueprint can change catalog visibility",
			);
		}
		blueprint.visibility = input.visibility;
		blueprint.updatedAt = now();
		return { blueprint };
	},
	"osWorkspaces/blueprints/export": (input: {
		blueprintId: string;
		revisionId?: string;
	}) => {
		const blueprint = findBlueprint(input.blueprintId);
		const revision = input.revisionId
			? state.blueprintRevisions.find(
					(row) =>
						row.id === input.revisionId && row.blueprintId === blueprint.id,
				)
			: latestRevision(
					state.blueprintRevisions.filter(
						(row) => row.blueprintId === blueprint.id,
					),
				);
		if (!revision) {
			throw new RpcError("BAD_REQUEST", "Blueprint has no revision to export");
		}
		const portableExport: OsBlueprintExport = {
			envelopeVersion: 1,
			exportedAt: now(),
			exportedByKind: "user",
			source: {
				organizationId: ORG_ID,
				organizationName: "Tedix local",
				blueprintId: blueprint.id,
				blueprintName: blueprint.name,
				revisionId: revision.id,
				revision: revision.revision,
				definitionSha256: "a".repeat(64),
				forkedAt: now(),
				via: "export",
				attested: true,
			},
			blueprint: {
				name: blueprint.name,
				description: blueprint.description,
				status: blueprint.status,
			},
			revision: {
				revision: revision.revision,
				createdAt: revision.createdAt,
				publishedAt: revision.publishedAt,
				createdByKind: revision.createdByKind,
			},
			definition: revision.definition,
			lineage: blueprint.lineage,
		};
		return { export: portableExport };
	},
	"osWorkspaces/blueprints/import": (input: {
		export: OsBlueprintExport;
		name?: string;
	}) => {
		const name = input.name ?? input.export.blueprint.name;
		if (state.blueprints.some((row) => row.name === name)) {
			throw new RpcError(
				"CONFLICT",
				"A blueprint with this name already exists in the organization",
			);
		}
		const createdAt = now();
		const blueprintId = nextId();
		const revisionId = nextId();
		const inherited = (input.export.lineage?.chain ?? []).map((entry) => ({
			...entry,
			attested: false,
		}));
		const chain = [
			{ ...input.export.source, attested: false as const },
			...inherited,
		];
		const blueprint: OsBlueprint = {
			id: blueprintId,
			organizationId: ORG_ID,
			name,
			description: input.export.blueprint.description,
			status: "draft",
			visibility: "org",
			currentRevisionId: revisionId,
			lineage: {
				version: 1,
				chain: chain.slice(0, 20),
				truncated:
					chain.length > 20 || (input.export.lineage?.truncated ?? false),
			},
			createdByKind: "user",
			createdById: "dev-operator",
			createdAt,
			updatedAt: createdAt,
		};
		const revision: OsBlueprintRevision = {
			id: revisionId,
			organizationId: ORG_ID,
			blueprintId,
			revision: 1,
			definition: input.export.definition,
			createdByKind: "user",
			createdById: "dev-operator",
			createdAt,
			publishedAt: null,
		};
		state.blueprints.push(blueprint);
		state.blueprintRevisions.push(revision);
		return { blueprint, revision };
	},
	"osWorkspaces/blueprints/instantiate": (input: {
		blueprintId: string;
		workspaceName: string;
		description?: string;
		resourceBindings?: Array<{
			slot: string;
			selection: Omit<
				OsWorkspaceResource,
				| "id"
				| "organizationId"
				| "workspaceId"
				| "slot"
				| "status"
				| "createdByKind"
				| "createdById"
				| "createdAt"
				| "updatedAt"
				| "removedAt"
			>;
		}>;
	}) => {
		const blueprint = findBlueprint(input.blueprintId);
		if (blueprint.status !== "published") {
			throw new RpcError(
				"BAD_REQUEST",
				"Only a published blueprint instantiates",
			);
		}
		const revision = latestRevision(
			state.blueprintRevisions.filter(
				(row) => row.blueprintId === blueprint.id,
			),
		);
		if (!revision) {
			throw new RpcError("BAD_REQUEST", "Published blueprint has no revision");
		}
		if (state.workspaces.some((row) => row.name === input.workspaceName)) {
			throw new RpcError("CONFLICT", "Workspace name already taken");
		}
		const createdAt = now();
		// The local surface resolves no tenant state, so it reports exactly what
		// the real preflight reports when nothing was resolved: `not_configured`
		// with an empty decision trail. It never fabricates satisfied pins.
		const preflight: OsBlueprintPreflight = {
			blueprintId: blueprint.id,
			revisionId: revision.id,
			revision: revision.revision,
			status: "not_configured",
			instantiateAllowed: true,
			targetTediId: null,
			requirements: null,
			decisions: [],
			blockingReasons: [],
			configurationReasons: [],
			consentReasons: [],
			resolvedAt: createdAt,
		};
		const workspace: OsWorkspace = {
			id: nextId(),
			organizationId: ORG_ID,
			name: input.workspaceName,
			description: input.description ?? blueprint.description,
			status: "active",
			sourceBlueprintId: blueprint.id,
			sourceBlueprintRevisionId: revision.id,
			sourceBlueprintRevisionNumber: revision.revision,
			instantiationPreflight: preflight,
			rollbackReference: null,
			blueprintDecision: null,
			createdByKind: "user",
			createdById: "dev-operator",
			createdAt,
			updatedAt: createdAt,
			visibility: "org",
			ownerUserId: null,
		};
		state.workspaces.push(workspace);
		const resources = (input.resourceBindings ?? []).map((binding) => {
			const resource: OsWorkspaceResource = {
				...binding.selection,
				id: nextId(),
				organizationId: ORG_ID,
				workspaceId: workspace.id,
				slot: binding.slot,
				status: "active",
				createdByKind: "user",
				createdById: "dev-operator",
				createdAt,
				updatedAt: createdAt,
				removedAt: null,
			};
			state.workspaceResources.push(resource);
			return resource;
		});
		const gadgets = revision.definition.gadgets.map((declared) => {
			const gadget: OsGadget = {
				id: nextId(),
				organizationId: ORG_ID,
				workspaceId: workspace.id,
				name: declared.name,
				description: null,
				status: "active",
				currentRevisionId: null,
				sourceBlueprintRevisionId: revision.id,
				createdByKind: "user",
				createdById: "dev-operator",
				createdAt,
				updatedAt: createdAt,
			};
			const gadgetRevision: OsGadgetRevision = {
				id: nextId(),
				organizationId: ORG_ID,
				gadgetId: gadget.id,
				revision: 1,
				manifest: declared.manifest,
				sourceArtifactRef: null,
				createdByKind: "user",
				createdById: "dev-operator",
				createdAt,
			};
			gadget.currentRevisionId = gadgetRevision.id;
			state.gadgets.push(gadget);
			state.gadgetRevisions.push(gadgetRevision);
			return { gadget, revision: gadgetRevision };
		});
		return { workspace, blueprint, revision, preflight, resources, gadgets };
	},
	"osWorkspaces/blueprints/instantiateFromGallery": (input: {
		blueprintId: string;
		workspaceName: string;
		tediId?: string;
	}) => {
		const source = findBlueprint(input.blueprintId);
		if (source.status !== "published" || source.visibility !== "catalog") {
			throw new RpcError("NOT_FOUND", "OS blueprint not found");
		}
		const sourceRevision = latestRevision(
			state.blueprintRevisions.filter((row) => row.blueprintId === source.id),
		);
		if (!sourceRevision) {
			throw new RpcError("NOT_FOUND", "OS blueprint not found");
		}
		const createdAt = now();
		const blueprintId = nextId();
		const revisionId = nextId();
		const blueprint: OsBlueprint = {
			...source,
			id: blueprintId,
			name: `${source.name} copy`,
			description:
				`${source.description ?? ""}\n\nImported from the blueprint gallery: "${source.name}" by Tedix local.`.trim(),
			visibility: "org",
			currentRevisionId: revisionId,
			createdAt,
			updatedAt: createdAt,
		};
		const revision: OsBlueprintRevision = {
			...sourceRevision,
			id: revisionId,
			blueprintId,
			revision: 1,
			createdAt,
		};
		state.blueprints.push(blueprint);
		state.blueprintRevisions.push(revision);
		return blueprintHandlers["osWorkspaces/blueprints/instantiate"]!({
			blueprintId,
			workspaceName: input.workspaceName,
		} as never);
	},
};
