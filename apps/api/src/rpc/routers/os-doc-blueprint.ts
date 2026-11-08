import { implement } from "@orpc/server";
import { osWorkspacesContract } from "@tedix/api-contract/contracts/os-workspaces";
import { buildDocBlueprint } from "@tedix/api-contract/assets/doc-blueprint";
import { appRuntimeCodeLength } from "@tedix/api-contract/utils/app-runtime";
import { getOsGadget } from "@tedix/db/queries/os-workspaces/gadgets";
import {
	findWorkspaceOutputResource,
	installWorkspaceApp,
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

const author = implement(osWorkspacesContract)
	.$context<BaseContext>()
	.use(withAuth)
	.use(osAudit(OS_WORKSPACES_AUDIT))
	.use(AUTHZ.osAuthor);

export const installDocument = author.gadgets.installDocument.handler(
	async ({ input, context }) => {
		const workspace = await requireWorkspace(context, input.workspaceId);
		const output = await requireOutput(context, input.outputId);
		if (
			output.workspaceId !== workspace.id ||
			output.kind !== "document" ||
			output.status !== "active" ||
			!output.currentRevisionId
		)
			throw createError(
				ErrorCodes.NOT_FOUND,
				"Active workspace document not found",
			);
		const revision = await getOsOutputRevision(queryDb(context), {
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
				"Document source access is unavailable",
			);
		const creator = resolveCreator(context);
		const now = new Date().toISOString();
		const identity = async (key: string) => {
			const hash = await canonicalDigest([
				workspace.organizationId,
				"doc-blueprint-v1",
				key,
			]);
			return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
		};
		const gadgetId = await identity(`app:${workspace.id}:${output.id}`);
		const existing = await getOsGadget(queryDb(context), {
			organizationId: workspace.organizationId,
			gadgetId,
		});
		if (existing) {
			if (existing.status !== "active")
				throw createError(ErrorCodes.CONFLICT, "The Doc app is archived");
			return { gadget: mapGadget(existing) };
		}
		const resource = await findWorkspaceOutputResource(queryDb(context), {
			organizationId: workspace.organizationId,
			workspaceId: workspace.id,
			outputId: output.id,
		});
		if (resource && (resource.status !== "active" || !resource.slot))
			throw createError(
				ErrorCodes.CONFLICT,
				"The document resource must have an active slot before attaching a Doc app",
			);
		const slot = resource?.slot ?? `doc_${output.id.replaceAll("-", "")}`;
		const definition = buildDocBlueprint(slot);
		const template = buildDocBlueprint();
		const declared = definition.gadgets[0]!;
		const files = declared.files!;
		const blueprintId = await identity("template");
		const blueprintRevisionId = await identity("template-revision");
		const revisionId = await identity(`revision:${gadgetId}`);
		const base = {
			organizationId: workspace.organizationId,
			createdByKind: creator.kind,
			createdById: creator.id,
			createdAt: now,
		};
		await installWorkspaceApp(queryDb(context), {
			blueprint: {
				...base,
				id: blueprintId,
				name: `Doc editor (${blueprintId.slice(0, 8)})`,
				description:
					"Reusable document editor. Instances bind a document output; the template contains no document content.",
				status: "published",
				visibility: "org",
				currentRevisionId: blueprintRevisionId,
				updatedAt: now,
			},
			blueprintRevision: {
				...base,
				id: blueprintRevisionId,
				blueprintId,
				revision: 1,
				definition: JSON.stringify(template),
				publishedAt: now,
			},
			gadget: {
				...base,
				id: gadgetId,
				workspaceId: workspace.id,
				name: `Doc · ${output.title.slice(0, 140)} (${output.id.slice(0, 8)})`,
				description: "Edit this workspace document",
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
							metadata: JSON.stringify({ gadgetId, kind: "document" }),
							updatedAt: now,
						},
					}
				: {}),
		});
		const gadget = await getOsGadget(queryDb(context), {
			organizationId: workspace.organizationId,
			gadgetId,
		});
		if (!gadget)
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				"Doc app installation failed",
			);
		return { gadget: mapGadget(gadget) };
	},
);
