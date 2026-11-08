import { implement } from "@orpc/server";
import { osWorkspacesContract } from "@tedix/api-contract/contracts/os-workspaces";
import {
	buildDocBlueprint,
	DOC_BLUEPRINT_VERSION,
} from "@tedix/api-contract/assets/doc-blueprint";
import {
	buildSheetBlueprint,
	SHEET_BLUEPRINT_VERSION,
} from "@tedix/api-contract/assets/sheet-blueprint";
import {
	buildSlidesBlueprint,
	SLIDES_BLUEPRINT_VERSION,
} from "@tedix/api-contract/assets/slides-blueprint";
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
import { canonicalDigest } from "../../lib/blueprint-digest";
import { getOsOutputRevision } from "../../services/workspace-output-storage";
import {
	authorizeDerivedOutputSources,
	parseDerivedAccessEnvelope,
} from "../../services/os-derived-resource-access";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
} from "../orpc";
import { OS_WORKSPACES_AUDIT, osAudit } from "../os-audit";
import {
	mapGadget,
	queryDb,
	requireOutput,
	requireWorkspace,
	resolveCreator,
} from "./os-workspaces-shared";

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

type EditorInput = {
	workspaceId: string;
	outputId: string;
	kind: keyof typeof EDITORS;
	upgradeFromRevisionId?: string;
};

async function installEditor(input: EditorInput, context: BaseContext) {
	const workspace = await requireWorkspace(context, input.workspaceId);
	const output = await requireOutput(context, input.outputId);
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
	const revision = await getOsOutputRevision(db, {
		organizationId: workspace.organizationId,
		revisionId: output.currentRevisionId,
	});
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
	const identity = async (key: string) => {
		const hash = await canonicalDigest([
			workspace.organizationId,
			editor.seed,
			key,
		]);
		return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
	};
	const blueprintId = await identity("template");
	const resource = await findWorkspaceOutputResource(db, {
		organizationId: workspace.organizationId,
		workspaceId: workspace.id,
		outputId: output.id,
	});
	if (resource && (resource.status !== "active" || !resource.slot))
		throw createError(
			ErrorCodes.CONFLICT,
			"The output resource needs an active slot before attaching an editor",
		);
	const finish = async (
		gadget: NonNullable<Awaited<ReturnType<typeof getOsGadget>>>,
	) => {
		if (
			resource &&
			!(await linkWorkspaceOutputEditor(db, {
				organizationId: workspace.organizationId,
				workspaceId: workspace.id,
				resourceId: resource.id,
				outputId: output.id,
				expectedSlot: slot,
				gadgetId: gadget.id,
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
	const stableGadgetId = await identity(`app:${workspace.id}:${output.id}`);
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
	const declared = definition.gadgets[0]!;
	const files = declared.files!;
	const publication = {
		blueprint: {
			...base,
			id: blueprintId,
			name: `${editor.label} editor (${blueprintId.slice(0, 8)})`,
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
			revision: editor.version,
			definition: JSON.stringify(template),
			publishedAt: now,
		},
	};
	if (existing) {
		const previous = existing.currentRevisionId
			? await getOsGadgetRevision(db, {
					organizationId: workspace.organizationId,
					revisionId: existing.currentRevisionId,
				})
			: undefined;
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

const author = implement(osWorkspacesContract)
	.$context<BaseContext>()
	.use(withAuth)
	.use(osAudit(OS_WORKSPACES_AUDIT))
	.use(AUTHZ.osAuthor);

export const installOutputEditor = author.gadgets.installOutputEditor.handler(
	({ input, context }) => installEditor(input, context),
);
export const installDocument = author.gadgets.installDocument.handler(
	({ input, context }) =>
		installEditor({ ...input, kind: "document" }, context),
);
