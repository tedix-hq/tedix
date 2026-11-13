import { AppRuntimeConfigSchema } from "@tedix/api-contract/schemas/os-app-runtime";
import { buildDocBlueprint } from "@tedix/api-contract/assets/doc-blueprint";
import { buildSheetBlueprint } from "@tedix/api-contract/assets/sheet-blueprint";
import { buildSlidesBlueprint } from "@tedix/api-contract/assets/slides-blueprint";
import {
	DOC_BLUEPRINT_VERSION,
	SHEET_BLUEPRINT_VERSION,
	SLIDES_BLUEPRINT_VERSION,
} from "@tedix/api-contract/assets/office-editor-versions";
import { appRuntimeCodeLength } from "@tedix/api-contract/utils/app-runtime";
import {
	createOsGadgetRevision,
	getOsGadget,
	getOsGadgetRevision,
} from "@tedix/db/queries/os-workspaces/gadgets";
import {
	findWorkspaceOutputEditor,
	findWorkspaceOutputResource,
	installWorkspaceApp,
	publishWorkspaceAppTemplate,
	linkWorkspaceOutputEditor,
} from "@tedix/db/queries/os-workspaces/install-app";
import { findOsBlueprintIdByName } from "@tedix/db/queries/os-workspaces/blueprints";
import { canonicalDigest } from "../lib/blueprint-digest";
import { getOsOutputRevision } from "./workspace-output-storage";
import {
	authorizeDerivedOutputSources,
	parseDerivedAccessEnvelope,
} from "./os-derived-resource-access";
import { type BaseContext, createError, ErrorCodes } from "../rpc/orpc";
import {
	mapGadget,
	mapGadgetRevision,
	queryDb,
	requireOutput,
	requireWorkspace,
	resolveCreator,
} from "../rpc/routers/os-workspaces-shared";

const EDITORS = {
	document: {
		build: buildDocBlueprint,
		version: DOC_BLUEPRINT_VERSION,
		seed: "doc-blueprint-v1",
		slot: "doc",
		label: "Doc",
	},
	sheet: {
		build: buildSheetBlueprint,
		version: SHEET_BLUEPRINT_VERSION,
		seed: "sheet-blueprint-v1",
		slot: "sheet",
		label: "Sheet",
	},
	presentation: {
		build: buildSlidesBlueprint,
		version: SLIDES_BLUEPRINT_VERSION,
		seed: "slides-blueprint-v1",
		slot: "slides",
		label: "Slides",
	},
};

export type OutputEditorKind = keyof typeof EDITORS;

export function isOutputEditorKind(kind: string): kind is OutputEditorKind {
	return Object.hasOwn(EDITORS, kind);
}

async function editorIdentity(
	organizationId: string,
	kind: OutputEditorKind,
	key: string,
) {
	const hash = await canonicalDigest([organizationId, EDITORS[kind].seed, key]);
	return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/** The id of the editor gadget installed for one output in one workspace. */
export function outputEditorGadgetId(scope: {
	organizationId: string;
	workspaceId: string;
	outputId: string;
	kind: OutputEditorKind;
}) {
	return editorIdentity(
		scope.organizationId,
		scope.kind,
		`app:${scope.workspaceId}:${scope.outputId}`,
	);
}

/**
 * The editor gadget an output resource opens in, when that gadget is the
 * per-output editor this module installs (not an app bound to the output).
 */
export async function boundOutputEditorGadgetId(resource: {
	organizationId: string;
	workspaceId: string;
	resourceType: string;
	providerResourceId: string;
	metadata: string;
}): Promise<string | null> {
	if (resource.resourceType !== "output") return null;
	const gadgetId = linkedGadgetId(resource.metadata);
	const kind = resourceKind(resource.metadata);
	if (!gadgetId || !kind) return null;
	const expected = await outputEditorGadgetId({
		organizationId: resource.organizationId,
		workspaceId: resource.workspaceId,
		outputId: resource.providerResourceId,
		kind,
	});
	return expected === gadgetId ? gadgetId : null;
}

export type EditorInput = {
	workspaceId: string;
	outputId: string;
	kind: keyof typeof EDITORS;
	upgradeFromRevisionId?: string;
};

/**
 * Install (or reuse) the reusable editor gadget for one workspace output and
 * point the output's resource at it. The gadget renders the typed Output; no
 * second copy of the body is stored.
 */
export async function installOutputEditor(
	input: EditorInput,
	context: BaseContext,
) {
	const [workspace, output] = await Promise.all([
		requireWorkspace(context, input.workspaceId),
		requireOutput(context, input.outputId),
	]);
	if (
		output.workspaceId !== workspace.id ||
		output.kind !== input.kind ||
		output.status !== "active" ||
		!output.currentRevisionId
	)
		throw createError(
			ErrorCodes.NOT_FOUND,
			"Active workspace output not found",
		);
	const db = queryDb(context);
	const [revision, resource] = await Promise.all([
		getOsOutputRevision(db, {
			organizationId: workspace.organizationId,
			revisionId: output.currentRevisionId,
		}),
		findWorkspaceOutputResource(db, {
			organizationId: workspace.organizationId,
			workspaceId: workspace.id,
			outputId: output.id,
		}),
	]);
	const envelope = revision
		? parseDerivedAccessEnvelope(revision.accessEnvelope)
		: null;
	if (
		!envelope ||
		!(await authorizeDerivedOutputSources(context, {
			organizationId: workspace.organizationId,
			accessEnvelope: envelope,
		}))
	)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Output source access is unavailable",
		);
	const editor = EDITORS[input.kind];
	const identity = (key: string) =>
		editorIdentity(workspace.organizationId, input.kind, key);
	const blueprintId = await identity("template");
	if (resource && (resource.status !== "active" || !resource.slot))
		throw createError(
			ErrorCodes.CONFLICT,
			"The output resource needs an active slot before attaching an editor",
		);
	const finish = async (
		gadget: NonNullable<Awaited<ReturnType<typeof getOsGadget>>>,
	) => {
		if (!gadget.currentRevisionId)
			throw createError(
				ErrorCodes.CONFLICT,
				"The editor revision is unavailable",
			);
		if (
			resource &&
			!(await linkWorkspaceOutputEditor(db, {
				organizationId: workspace.organizationId,
				workspaceId: workspace.id,
				resourceId: resource.id,
				outputId: output.id,
				expectedSlot: slot,
				gadgetId: gadget.id,
				expectedGadgetRevisionId: gadget.currentRevisionId,
				kind: input.kind,
				now: new Date().toISOString(),
			}))
		)
			throw createError(
				ErrorCodes.CONFLICT,
				"The output binding changed. Reload before opening its editor.",
			);
		return { gadget: mapGadget(gadget) };
	};
	const slot =
		resource?.slot ?? `${editor.slot}_${output.id.replaceAll("-", "")}`;
	const stableGadgetId = await outputEditorGadgetId({
		organizationId: workspace.organizationId,
		workspaceId: workspace.id,
		outputId: output.id,
		kind: input.kind,
	});
	const existing =
		(await getOsGadget(db, {
			organizationId: workspace.organizationId,
			gadgetId: stableGadgetId,
		})) ??
		(resource?.slot
			? await findWorkspaceOutputEditor(db, {
					organizationId: workspace.organizationId,
					workspaceId: workspace.id,
					blueprintId,
					slot,
				})
			: undefined);
	if (existing?.status === "archived")
		throw createError(ErrorCodes.CONFLICT, "The editor app is archived");
	const previous = existing?.currentRevisionId
		? await getOsGadgetRevision(db, {
				organizationId: workspace.organizationId,
				revisionId: existing.currentRevisionId,
			})
		: undefined;
	const existingConfig = previous
		? AppRuntimeConfigSchema.safeParse(
				mapGadgetRevision(previous).manifest.config,
			)
		: undefined;
	if (
		existing &&
		(!existingConfig?.success || existingConfig.data.settings?.slot !== slot)
	)
		throw createError(
			ErrorCodes.CONFLICT,
			"The editor now uses a different file binding. Restore its binding or create a separate editor.",
		);
	if (existing && !input.upgradeFromRevisionId) return finish(existing);
	if (!existing && input.upgradeFromRevisionId)
		throw createError(ErrorCodes.CONFLICT, "The editor app no longer exists");
	const blueprintRevisionId = await identity(
		editor.version === 1
			? "template-revision"
			: `template-revision:${editor.version}`,
	);
	const gadgetId = existing?.id ?? stableGadgetId;
	const revisionId = await identity(
		existing
			? `upgrade:${gadgetId}:${input.upgradeFromRevisionId}:${editor.version}`
			: `revision:${gadgetId}`,
	);
	if (existing && existing.currentRevisionId !== input.upgradeFromRevisionId) {
		if (existing.currentRevisionId === revisionId) return finish(existing);
		throw createError(
			ErrorCodes.CONFLICT,
			"The editor changed. Reload before upgrading it.",
		);
	}
	if (existing?.sourceBlueprintRevisionId === blueprintRevisionId)
		return finish(existing);
	const creator = resolveCreator(context);
	const now = new Date().toISOString();
	const base = {
		organizationId: workspace.organizationId,
		createdByKind: creator.kind,
		createdById: creator.id,
		createdAt: now,
	};
	const definition = editor.build(slot);
	const template = editor.build();
	for (const versioned of [definition, template]) {
		const manifest = versioned.gadgets[0]!.manifest;
		const config = AppRuntimeConfigSchema.parse(manifest.config);
		manifest.config = {
			...config,
			settings: {
				...config.settings,
				blueprintVersion: editor.version,
			},
		};
	}
	const declared = definition.gadgets[0]!;
	const files = declared.files!;
	// A plain name unless someone in the organization already uses it.
	const templateName = async () => {
		const plain = `${editor.label} editor`;
		const holder = await findOsBlueprintIdByName(db, {
			organizationId: workspace.organizationId,
			name: plain,
		});
		return holder === null || holder === blueprintId
			? plain
			: `${plain} (${blueprintId.slice(0, 8)})`;
	};
	const publication = {
		templateVersion: editor.version,
		blueprint: {
			...base,
			id: blueprintId,
			name: await templateName(),
			description: `Reusable ${editor.label} editor. The template contains code and settings, without document content.`,
			status: "published" as const,
			visibility: "org" as const,
			currentRevisionId: blueprintRevisionId,
			updatedAt: now,
		},
		blueprintRevision: {
			...base,
			id: blueprintRevisionId,
			blueprintId,
			definition: JSON.stringify(template),
			publishedAt: now,
		},
	};
	if (existing) {
		if (!previous)
			throw createError(
				ErrorCodes.CONFLICT,
				"The editor revision is unavailable",
			);
		await publishWorkspaceAppTemplate(db, publication);
		const upgraded = await createOsGadgetRevision(db, {
			...base,
			id: revisionId,
			gadgetId,
			manifest: JSON.stringify(declared.manifest),
			sourceBlueprintRevisionId: blueprintRevisionId,
			expectedRevision: previous.revision,
			code: {
				files: JSON.stringify(files),
				codeLength: appRuntimeCodeLength(files),
			},
		});
		if (!upgraded.ok)
			throw createError(
				ErrorCodes.CONFLICT,
				"The editor changed. Reload before upgrading it.",
			);
	} else {
		await installWorkspaceApp(db, {
			...publication,
			gadget: {
				...base,
				id: gadgetId,
				workspaceId: workspace.id,
				name: `${editor.label} · ${output.title.slice(0, 140)} (${output.id.slice(0, 8)})`,
				description: `Edit this workspace ${input.kind}`,
				status: "active",
				currentRevisionId: revisionId,
				sourceBlueprintRevisionId: blueprintRevisionId,
				updatedAt: now,
			},
			revision: {
				...base,
				id: revisionId,
				gadgetId,
				revision: 1,
				manifest: JSON.stringify(declared.manifest),
			},
			code: {
				organizationId: workspace.organizationId,
				revisionId,
				gadgetId,
				files: JSON.stringify(files),
				codeLength: appRuntimeCodeLength(files),
				createdAt: now,
			},
			...(!resource
				? {
						resource: {
							...base,
							id: await identity(`resource:${workspace.id}:${output.id}`),
							workspaceId: workspace.id,
							slot,
							providerId: "tedix",
							connectionScope: "tenant" as const,
							resourceType: "output",
							providerResourceId: output.id,
							name: output.title,
							metadata: JSON.stringify({ gadgetId, kind: input.kind }),
							updatedAt: now,
						},
					}
				: {}),
		});
	}
	const gadget = await getOsGadget(db, {
		organizationId: workspace.organizationId,
		gadgetId,
	});
	if (!gadget)
		throw createError(
			ErrorCodes.INTERNAL_SERVER_ERROR,
			"Editor app installation failed",
		);
	return finish(gadget);
}

export type AttachOutputEditorResult =
	| { status: "attached"; gadgetId: string }
	| { status: "linked"; gadgetId: string }
	| { status: "skipped"; reason: "no_workspace" | "kind" | "inactive" }
	| { status: "failed"; reason: string };

/**
 * Give a new or existing workspace output its editor gadget, unless its
 * resource already opens in an active gadget (a blueprint app, for example).
 * Creation must not fail because of this step, so errors are returned and
 * logged; the next call, or the backfill, retries the same idempotent install.
 */
export async function attachOutputEditor(
	context: BaseContext,
	output: {
		id: string;
		organizationId: string;
		workspaceId: string | null;
		kind: string;
		status?: string;
	},
): Promise<AttachOutputEditorResult> {
	if (!output.workspaceId) return { status: "skipped", reason: "no_workspace" };
	if (!isOutputEditorKind(output.kind))
		return { status: "skipped", reason: "kind" };
	if (output.status && output.status !== "active")
		return { status: "skipped", reason: "inactive" };
	try {
		const db = queryDb(context);
		const resource = await findWorkspaceOutputResource(db, {
			organizationId: output.organizationId,
			workspaceId: output.workspaceId,
			outputId: output.id,
		});
		const linkedId = resource?.metadata
			? linkedGadgetId(resource.metadata)
			: null;
		if (resource?.status === "active" && linkedId) {
			const linked = await getOsGadget(db, {
				organizationId: output.organizationId,
				gadgetId: linkedId,
			});
			if (linked?.status === "active")
				return { status: "linked", gadgetId: linked.id };
		}
		const { gadget } = await installOutputEditor(
			{
				workspaceId: output.workspaceId,
				outputId: output.id,
				kind: output.kind,
			},
			context,
		);
		return { status: "attached", gadgetId: gadget.id };
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		console.warn(
			JSON.stringify({
				event: "output_editor_attach_failed",
				organizationId: output.organizationId,
				outputId: output.id,
				reason,
			}),
		);
		return { status: "failed", reason };
	}
}

function metadataField(metadata: string, field: string): string | null {
	try {
		const parsed: unknown = JSON.parse(metadata);
		if (parsed && typeof parsed === "object" && field in parsed) {
			const value: unknown = (parsed as Record<string, unknown>)[field];
			return typeof value === "string" && value ? value : null;
		}
	} catch {
		// Unreadable metadata links nothing.
	}
	return null;
}

function linkedGadgetId(metadata: string): string | null {
	return metadataField(metadata, "gadgetId");
}

function resourceKind(metadata: string): OutputEditorKind | null {
	const kind = metadataField(metadata, "kind");
	return kind && isOutputEditorKind(kind) ? kind : null;
}
