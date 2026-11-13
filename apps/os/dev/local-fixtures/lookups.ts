/**
 * Lookups and builders over the in-memory store: pagination, finders, output
 * editors, blueprints, the output library and the catalog.
 */

import { documentBlockText } from "@tedix/api-contract/utils/os-document";
import type { CatalogAppDetail } from "@tedix/api-contract/schemas/catalog";
import type {
	HomeConversation,
	HomeRun,
} from "@tedix/api-contract/schemas/kernel-runtime";
import type { OsBlueprintWithVisibility as OsBlueprint } from "@tedix/api-contract/contracts/os-workspaces";
import type {
	OsBlueprintPreflight,
	OsBlueprintRevision,
	OsCollaborationProposal,
	OsGadget,
	OsOutput,
	OsOutputLibraryItem,
	OsOutputRevision,
	OsWorkspace,
} from "@tedix/api-contract/schemas/os-workspaces";
import {
	APP_RUNTIME_ENTRY,
	fid,
	nextId,
	now,
	ORG_ID,
	RpcError,
	type SkillRunRow,
} from "./core";
import { state } from "./state";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export type Pagination = { limit?: number; offset?: number };

export const paginate = <T>(rows: T[], input?: Pagination) => {
	const limit = input?.limit ?? 50;
	const offset = input?.offset ?? 0;
	return {
		data: rows.slice(offset, offset + limit),
		pagination: {
			limit,
			offset,
			total: rows.length,
			hasMore: offset + limit < rows.length,
		},
	};
};

export const createLocalWorkspace = (input: {
	name: string;
	description?: string;
	visibility?: OsWorkspace["visibility"];
}) => {
	const workspace: OsWorkspace = {
		id: nextId(),
		organizationId: ORG_ID,
		name: input.name,
		description: input.description ?? null,
		status: "active",
		sourceBlueprintId: null,
		sourceBlueprintRevisionId: null,
		sourceBlueprintRevisionNumber: null,
		instantiationPreflight: null,
		rollbackReference: null,
		blueprintDecision: null,
		createdByKind: "user",
		createdById: "dev-operator",
		createdAt: now(),
		updatedAt: now(),
		visibility: input.visibility ?? "org",
		ownerUserId: input.visibility === "private" ? "dev-operator" : null,
	};
	state.workspaces.push(workspace);
	return { workspace };
};

export const findWorkspace = (workspaceId: string): OsWorkspace => {
	const workspace = state.workspaces.find((row) => row.id === workspaceId);
	if (!workspace) throw new RpcError("NOT_FOUND", "Workspace not found");
	return workspace;
};

export const findGadget = (workspaceId: string, gadgetId: string): OsGadget => {
	const gadget = state.gadgets.find(
		(row) => row.id === gadgetId && row.workspaceId === workspaceId,
	);
	if (!gadget) throw new RpcError("NOT_FOUND", "Gadget not found");
	return gadget;
};

export const findOutput = (outputId: string): OsOutput => {
	const output = state.outputs.find((row) => row.id === outputId);
	if (!output) throw new RpcError("NOT_FOUND", "Output not found");
	return output;
};

const LOCAL_EDITORS = {
	document: {
		version: 2,
		label: "Doc",
		slot: "doc",
		family: "d0",
	},
	sheet: {
		version: 1,
		label: "Sheet",
		slot: "sheet",
		family: "d1",
	},
	presentation: {
		version: 1,
		label: "Slides",
		slot: "slides",
		family: "d2",
	},
};
function localEditorDefinition(
	kind: keyof typeof LOCAL_EDITORS,
	slot: string,
): OsBlueprintRevision["definition"] {
	const editor = LOCAL_EDITORS[kind];
	return {
		gadgets: [
			{
				name: editor.label,
				manifest: {
					entry: APP_RUNTIME_ENTRY,
					capabilities: [],
					config: {
						version: 1,
						settings: {
							slot,
						},
					},
					resourceGrants: [
						{
							slot,
							operations: ["outputs.read", "outputs.write", "outputs.patch"],
						},
					],
				},
				files: {
					"client.js":
						"document.getElementById('app').textContent = 'Local editor preview';",
					"server.js": "export class App {}",
				},
			},
		],
		requirements: {
			version: 1,
			skills: [],
			connections: [],
			policies: [],
			runtime: null,
			layout: null,
			outputs: [
				{ gadget: editor.label, kind, title: `Untitled ${kind}`, slot },
			],
		},
	};
}
export function installLocalOutputEditor(input: {
	workspaceId: string;
	outputId: string;
	kind: keyof typeof LOCAL_EDITORS;
	upgradeFromRevisionId?: string;
}) {
	findWorkspace(input.workspaceId);
	const output = findOutput(input.outputId);
	if (
		output.workspaceId !== input.workspaceId ||
		output.kind !== input.kind ||
		output.status !== "active" ||
		!output.currentRevisionId
	)
		throw new RpcError("NOT_FOUND", "Active workspace output not found");
	const currentOutputRevision = state.outputRevisions.find(
		(row) => row.id === output.currentRevisionId,
	);
	if (!currentOutputRevision)
		throw new RpcError("NOT_FOUND", "Output revision not found");
	// Local fixtures have no connected provider authority.
	if (currentOutputRevision.accessEnvelope?.sources.length)
		throw new RpcError(
			"FORBIDDEN",
			"Output source access is unavailable locally",
		);
	const editor = LOCAL_EDITORS[input.kind];
	const resource = state.workspaceResources.find(
		(row) =>
			row.workspaceId === input.workspaceId &&
			row.resourceType === "output" &&
			row.providerResourceId === output.id,
	);
	if (resource && (resource.status !== "active" || !resource.slot)) {
		throw new RpcError(
			"CONFLICT",
			"The output resource must have an active slot before attaching an editor",
		);
	}
	const slot =
		resource?.slot ?? `${editor.slot}_${output.id.replaceAll("-", "")}`;
	const blueprintId = fid(editor.family, 1);
	const blueprintRevisionId = fid(editor.family, editor.version + 1);
	const existing = state.gadgets.find(
		(gadget) =>
			gadget.workspaceId === input.workspaceId &&
			state.blueprintRevisions.some(
				(revision) =>
					revision.id === gadget.sourceBlueprintRevisionId &&
					revision.blueprintId === blueprintId,
			) &&
			state.gadgetRevisions.some(
				(revision) =>
					revision.id === gadget.currentRevisionId &&
					revision.manifest.resourceGrants?.some(
						(grant) => grant.slot === slot,
					),
			),
	);
	if (existing?.status !== undefined && existing.status !== "active")
		throw new RpcError("CONFLICT", "The editor app is archived");
	if (existing && !input.upgradeFromRevisionId) return { gadget: existing };
	if (
		input.upgradeFromRevisionId &&
		existing?.currentRevisionId !== input.upgradeFromRevisionId
	)
		throw new RpcError(
			"CONFLICT",
			"The editor changed. Reload before upgrading it.",
		);
	if (existing?.sourceBlueprintRevisionId === blueprintRevisionId)
		return { gadget: existing };
	const createdAt = now();
	const base = {
		organizationId: ORG_ID,
		createdByKind: "user" as const,
		createdById: "dev-operator",
		createdAt,
	};
	let blueprint = state.blueprints.find((row) => row.id === blueprintId);
	if (!blueprint) {
		blueprint = {
			...base,
			id: blueprintId,
			name: `${editor.label} editor`,
			description: `Reusable ${editor.label} editor`,
			status: "published",
			visibility: "org",
			currentRevisionId: blueprintRevisionId,
			lineage: null,
			updatedAt: createdAt,
		};
		state.blueprints.push(blueprint);
	}
	if (!state.blueprintRevisions.some((row) => row.id === blueprintRevisionId)) {
		state.blueprintRevisions.push({
			...base,
			id: blueprintRevisionId,
			blueprintId,
			revision: editor.version,
			definition: localEditorDefinition(input.kind, input.kind),
			publishedAt: createdAt,
		});
		blueprint.currentRevisionId = blueprintRevisionId;
		blueprint.updatedAt = createdAt;
	}
	const declared = localEditorDefinition(input.kind, slot).gadgets[0]!;
	const revisionId = nextId();
	const previous =
		existing &&
		state.gadgetRevisions.find((row) => row.id === existing.currentRevisionId);
	const gadget: OsGadget = {
		...base,
		id: existing?.id ?? nextId(),
		workspaceId: input.workspaceId,
		name: `${editor.label} · ${output.title.slice(0, 140)} (${output.id.slice(0, 8)})`,
		description: `Edit this workspace ${input.kind}`,
		status: "active",
		currentRevisionId: revisionId,
		sourceBlueprintRevisionId: blueprintRevisionId,
		updatedAt: createdAt,
	};
	if (existing) Object.assign(existing, gadget);
	else state.gadgets.push(gadget);
	state.gadgetRevisions.push({
		...base,
		id: revisionId,
		gadgetId: gadget.id,
		revision: (previous?.revision ?? 0) + 1,
		manifest: declared.manifest,
		sourceArtifactRef: null,
	});
	state.gadgetCode[revisionId] = declared.files!;
	if (!resource)
		state.workspaceResources.push({
			...base,
			id: nextId(),
			workspaceId: input.workspaceId,
			slot,
			providerId: "tedix",
			connectionScope: "tenant",
			personalOwnerUserId: null,
			connectionInstanceId: null,
			providerAccess: null,
			requiredScopes: [],
			resourceType: "output",
			providerResourceId: output.id,
			name: output.title,
			metadata: { gadgetId: gadget.id, kind: input.kind },
			status: "active",
			updatedAt: createdAt,
			removedAt: null,
		});
	return { gadget };
}

export const findCollaborationProposal = (
	proposalId: string,
): OsCollaborationProposal => {
	const proposal = state.collaborationProposals.find(
		(row) => row.id === proposalId,
	);
	if (!proposal) throw new RpcError("NOT_FOUND", "Proposal not found");
	return proposal;
};

export const findBlueprint = (blueprintId: string): OsBlueprint => {
	const blueprint = state.blueprints.find((row) => row.id === blueprintId);
	if (!blueprint) throw new RpcError("NOT_FOUND", "Blueprint not found");
	return blueprint;
};

/** A catalog blueprint's landing page, built from the same allowlist as the API. */
export function localGalleryPage(blueprintId: string) {
	const blueprint = state.blueprints.find(
		(row) =>
			row.id === blueprintId &&
			row.status === "published" &&
			row.visibility === "catalog",
	);
	if (!blueprint) throw new RpcError("NOT_FOUND", "OS blueprint not found");
	const revision = latestRevision(
		state.blueprintRevisions.filter((row) => row.blueprintId === blueprint.id),
	);
	const requirements = revision?.definition.requirements;
	return {
		id: blueprint.id,
		name: blueprint.name,
		description: blueprint.description,
		publishedAt: revision?.publishedAt ?? null,
		featured: state.featuredBlueprintIds.includes(blueprint.id),
		apps: (revision?.definition.gadgets ?? []).map((gadget) => ({
			name: gadget.name,
		})),
		needs: {
			connections: (requirements?.connections ?? []).map((row) => ({
				providerId: row.providerId,
			})),
			resources: (requirements?.resources ?? []).map((row) => ({
				label: row.label,
				providerId: row.providerId,
			})),
			skills: (requirements?.skills ?? []).map((row) => ({ slug: row.slug })),
			outputs: (requirements?.outputs ?? []).map((row) => ({
				title: row.title,
				kind: row.kind,
			})),
		},
		organizationName: "Tedix local",
	};
}

export const latestRevision = <T extends { revision: number }>(
	rows: T[],
): T | null =>
	rows.reduce<T | null>(
		(latest, row) =>
			latest === null || row.revision > latest.revision ? row : latest,
		null,
	);

/**
 * The local upgrade report: a real diff of the two revisions' apps. Nothing
 * resolves tenant state here, so every preflight says `not_configured`, the
 * same as local instantiate, and no requirement verdict is invented.
 */
export const localBlueprintUpgradeReport = (input: {
	workspaceId: string;
	candidateRevisionId?: string;
}) => {
	const workspace = findWorkspace(input.workspaceId);
	const pinned = state.blueprintRevisions.find(
		(row) => row.id === workspace.sourceBlueprintRevisionId,
	);
	if (!workspace.sourceBlueprintId || !pinned) {
		throw new RpcError(
			"BAD_REQUEST",
			"Workspace was not made from a blueprint",
		);
	}
	const blueprint = findBlueprint(workspace.sourceBlueprintId);
	const candidate = input.candidateRevisionId
		? state.blueprintRevisions.find(
				(row) =>
					row.id === input.candidateRevisionId &&
					row.blueprintId === blueprint.id,
			)
		: latestRevision(
				state.blueprintRevisions.filter(
					(row) => row.blueprintId === blueprint.id,
				),
			);
	if (!candidate) throw new RpcError("NOT_FOUND", "Revision not found");
	const resolvedAt = now();
	const preflight = (revision: OsBlueprintRevision): OsBlueprintPreflight => ({
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
		resolvedAt,
	});
	const before = new Map(
		pinned.definition.gadgets.map((row) => [row.name, row.manifest]),
	);
	const after = new Map(
		candidate.definition.gadgets.map((row) => [row.name, row.manifest]),
	);
	const gadgetChanges = [
		...[...after].map(([name, manifest]) => ({
			name,
			change: !before.has(name)
				? ("added" as const)
				: JSON.stringify(before.get(name)) === JSON.stringify(manifest)
					? ("unchanged" as const)
					: ("changed" as const),
		})),
		...[...before.keys()]
			.filter((name) => !after.has(name))
			.map((name) => ({ name, change: "removed" as const })),
	];
	return {
		workspace,
		candidate,
		report: {
			workspaceId: workspace.id,
			blueprintId: blueprint.id,
			pinnedRevisionId: pinned.id,
			pinnedRevision: pinned.revision,
			candidateRevisionId: candidate.id,
			candidateRevision: candidate.revision,
			upToDate: candidate.id === pinned.id,
			preflightAtInstantiation: workspace.instantiationPreflight,
			pinnedPreflightNow: preflight(pinned),
			candidatePreflightNow: preflight(candidate),
			requirementChanges: [],
			gadgetChanges,
			applyAllowed: true,
			blockingReasons: [],
			consentReasons: [],
			resolvedAt,
		},
	};
};

const compactOutputPreviewText = (value: string): string =>
	value.replace(/\s+/g, " ").trim().slice(0, 240);

export const localOutputLibraryItem = (
	output: OsOutput,
	revision: OsOutputRevision,
): OsOutputLibraryItem => {
	const content = revision.content;
	const preview: OsOutputLibraryItem["preview"] =
		content.kind === "document"
			? {
					kind: "document",
					lines: content.blocks
						.flatMap((block) => documentBlockText(block))
						.map(compactOutputPreviewText)
						.filter(Boolean)
						.slice(0, 6),
					blockCount: content.blocks.length,
				}
			: content.kind === "sheet"
				? {
						kind: "sheet",
						columns: content.columns
							.slice(0, 6)
							.map((value) => value.slice(0, 80)),
						rows: content.rows
							.slice(0, 5)
							.map((row) =>
								row
									.slice(0, 6)
									.map((cell) =>
										typeof cell === "string"
											? compactOutputPreviewText(cell)
											: cell,
									),
							),
						rowCount: content.rows.length,
						columnCount: content.columns.length,
						sheetCount: content.workbook?.sheets.length ?? 1,
					}
				: content.kind === "video"
					? {
							kind: "video",
							mimeType: content.mimeType,
							...(content.caption
								? { caption: compactOutputPreviewText(content.caption) }
								: {}),
						}
					: {
							kind: "presentation",
							title: compactOutputPreviewText(content.slides[0]?.title ?? ""),
							bullets: (content.slides[0]?.bullets ?? [])
								.slice(0, 4)
								.map(compactOutputPreviewText),
							slideCount: content.slides.length,
						};
	const workspace = output.workspaceId
		? state.workspaces.find((row) => row.id === output.workspaceId)
		: null;
	return {
		output,
		workspace: workspace
			? { id: workspace.id, name: workspace.name, status: workspace.status }
			: null,
		currentRevision: {
			id: revision.id,
			revision: revision.revision,
			createdAt: revision.createdAt,
		},
		scope:
			output.createdByKind === "user" && output.createdById === "dev-operator"
				? "mine"
				: "organization",
		preview,
	};
};

export const findSkillRun = (runId: string): SkillRunRow => {
	const run = state.skillRuns.find((row) => row.id === runId);
	if (!run) throw new RpcError("NOT_FOUND", "Skill run not found");
	return run;
};

export const findConversation = (
	conversationId: string,
): HomeConversation & { hidden?: boolean } => {
	const conversation = state.conversations.find(
		(row) => row.id === conversationId,
	);
	if (!conversation) throw new RpcError("NOT_FOUND", "Conversation not found");
	return conversation;
};

export const findHomeRun = (runId: string): HomeRun => {
	const run = state.homeRuns.find((row) => row.id === runId);
	if (!run) throw new RpcError("NOT_FOUND", "Run not found");
	return run;
};

export const CANNED_REPLY =
	"Noted — I logged that in the Home journal. Everything on this surface is running against local fixture data, so nothing left your machine.";

// Synthetic catalog entries for local discovery and install-review validation.
export const LOCAL_CATALOG = (
	[
		[
			"local-documents",
			"Documents",
			"Search documents and prepare a sourced team briefing.",
		],
		[
			"local-projects",
			"Projects",
			"Review project tasks and prepare a weekly progress report.",
		],
	] as const
).map(
	([slug, name, description]) =>
		({
			modelDescription: null,
			baseUrl: null,
			mcpEndpointNormalized: null,
			toolSource: null,
			distributionChannel: null,
			developerType: null,
			status: null,
			website: null,
			privacyPolicy: null,
			termsOfService: null,
			logoUrl: null,
			logoUrlDark: null,
			screenshots: null,
			keywordsForDiscovery: null,
			keywordsForTriggering: null,
			hasInteractive: null,
			hasFileSearch: null,
			hasDeepResearch: null,
			hasSync: null,
			authTypes: null,
			mcpServerName: null,
			mcpServerVersion: null,
			mcpToolCount: null,
			mcpResourceCount: null,
			mcpPromptCount: null,
			mcpLastScannedAt: null,
			mcpInstructions: null,
			healthLastCheckedAt: null,
			healthConnectTimeMs: null,
			healthUptimePercent: null,
			healthErrorMessage: null,
			screenshotUrl: null,
			seoDescription: null,
			socialLinks: null,
			examplePrompts: null,
			categories: null,
			lastSyncedAt: null,
			createdAt: null,
			updatedAt: null,
			sourceCreatedAt: null,
			id: slug,
			slug,
			name,
			description,
			connectorType: "MCP",
			category: "PRODUCTIVITY",
			developer: "Local fixture",
			healthStatus: "unknown",
			hasWrites: false,
			discoverability: { score: 0, label: "Low", criteria: [], tips: [] },
			quality: {
				score: 0,
				label: "Thin",
				status: "needs_review",
				logoStatus: "missing",
				sourceConfidence: "low",
				freshnessStatus: "unknown",
				signals: [],
			},
			installability: {
				installable: true,
				state: "installable",
				reason: "Synthetic local app for UI validation",
			},
			tools: [],
			resources: [],
			resourceTemplates: [],
			prompts: [],
			storeListings: [],
		}) satisfies CatalogAppDetail,
);
