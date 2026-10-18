import { implement } from "@orpc/server";
import { osWorkspacesContract } from "@tedix/api-contract/contracts/os-workspaces";
import { WORKSPACE_FILE_PART_BYTES } from "@tedix/api-contract/schemas/workspace-files";
import { confirmOsWorkspaceFile } from "@tedix/db/queries/os-workspaces/files";
import { getOsWorkspaceResource } from "@tedix/db/queries/os-workspaces/resources";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
} from "../orpc";
import { requireOrgId } from "../org-scope";
import { OS_WORKSPACES_AUDIT, osAudit } from "../os-audit";
import {
	queryDb,
	requireWorkspace,
	resolveCreator,
} from "./os-workspaces-shared";
import { mapWorkspaceResource } from "./os-workspace-resources";
import {
	readWorkspaceFileManifest,
	workspaceFileKey,
	workspaceFileSignature,
	type WorkspaceFileManifest,
} from "../../lib/workspace-files";

const os = implement(osWorkspacesContract)
	.$context<BaseContext>()
	.use(withAuth)
	.use(osAudit(OS_WORKSPACES_AUDIT));
const author = os.use(AUTHZ.osAuthor);
const read = os.use(AUTHZ.osRead);
function missing(): never {
	throw createError(ErrorCodes.NOT_FOUND, "Workspace file not found");
}

export const requestFileUpload = author.resources.requestFileUpload.handler(
	async ({ input, context }) => {
		const workspace = await requireWorkspace(context, input.workspaceId);
		const creator = resolveCreator(context);
		const resourceId = crypto.randomUUID();
		const key = workspaceFileKey(
			workspace.organizationId,
			workspace.id,
			resourceId,
		);
		const upload = await context.env.SKILL_ARTIFACTS.createMultipartUpload(
			key,
			{ httpMetadata: { contentType: input.mimeType } },
		);
		const now = Date.now();
		const exp = Math.floor(now / 1000) + 900;
		const manifest: WorkspaceFileManifest = {
			...input,
			organizationId: workspace.organizationId,
			resourceId,
			uploadId: upload.uploadId,
			createdByKind: creator.kind,
			createdById: creator.id,
			createdAt: new Date(now).toISOString(),
			expiresAt: new Date(exp * 1000).toISOString(),
		};
		try {
			await context.env.SKILL_ARTIFACTS.put(
				`${key}.json`,
				JSON.stringify(manifest),
			);
		} catch (error) {
			await upload.abort();
			throw error;
		}
		const parts = [];
		for (
			let offset = 0, partNumber = 1;
			offset < input.size;
			offset += WORKSPACE_FILE_PART_BYTES, partNumber++
		) {
			const url = new URL(
				`/workspace-file-uploads/${encodeURIComponent(workspace.organizationId)}/${workspace.id}/${resourceId}/${partNumber}`,
				context.env.API_URL,
			);
			url.searchParams.set("exp", String(exp));
			url.searchParams.set(
				"sig",
				await workspaceFileSignature(
					context.env.SECRETS_MASTER_KEY,
					`upload:${partNumber}`,
					workspace.organizationId,
					workspace.id,
					resourceId,
					exp,
				),
			);
			parts.push({
				partNumber,
				url: url.href,
				size: Math.min(WORKSPACE_FILE_PART_BYTES, input.size - offset),
			});
		}
		return {
			resourceId,
			expiresAt: manifest.expiresAt,
			partSize: WORKSPACE_FILE_PART_BYTES,
			parts,
		};
	},
);

export const confirmFileUpload = author.resources.confirmFileUpload.handler(
	async ({ input, context }) => {
		const workspace = await requireWorkspace(context, input.workspaceId);
		const organizationId = workspace.organizationId;
		const manifest = await readWorkspaceFileManifest(
			context.env,
			organizationId,
			workspace.id,
			input.resourceId,
		);
		if (!manifest) missing();
		const key = workspaceFileKey(
			organizationId,
			workspace.id,
			input.resourceId,
		);
		const existing = await getOsWorkspaceResource(queryDb(context), {
			organizationId: organizationId,
			workspaceId: workspace.id,
			resourceId: input.resourceId,
		});
		if (existing) {
			if (
				existing.status !== "active" ||
				existing.providerId !== "tedix" ||
				existing.resourceType !== "file"
			)
				missing();
			return {
				resource: mapWorkspaceResource(existing),
				outputId: existing.id,
			};
		}
		if (Date.parse(manifest.expiresAt) <= Date.now())
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Upload expired; request a new upload",
			);
		const count = Math.ceil(manifest.size / WORKSPACE_FILE_PART_BYTES);
		if (
			input.parts.length !== count ||
			input.parts.some((part, index) => part.partNumber !== index + 1)
		)
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Supply one ordered receipt for each part",
			);
		let head = await context.env.SKILL_ARTIFACTS.head(key);
		if (!head) {
			try {
				await context.env.SKILL_ARTIFACTS.resumeMultipartUpload(
					key,
					manifest.uploadId,
				).complete(input.parts);
			} catch (error) {
				// A concurrent confirmation may have completed the same immutable upload.
				if (!(await context.env.SKILL_ARTIFACTS.head(key))) throw error;
			}
			head = await context.env.SKILL_ARTIFACTS.head(key);
		}
		if (!head || head.size !== manifest.size)
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Uploaded size does not match the requested file",
			);
		const creator = {
			organizationId: organizationId,
			createdByKind: manifest.createdByKind,
			createdById: manifest.createdById,
			createdAt: manifest.createdAt,
		};
		await confirmOsWorkspaceFile(queryDb(context), {
			resource: {
				...creator,
				id: input.resourceId,
				workspaceId: workspace.id,
				providerId: "tedix",
				connectionScope: "tenant",
				requiredScopes: "[]",
				resourceType: "file",
				providerResourceId: input.resourceId,
				name: manifest.filename,
				metadata: JSON.stringify({
					mimeType: manifest.mimeType,
					size: manifest.size,
				}),
				status: "active",
				updatedAt: manifest.createdAt,
			},
			output: {
				...creator,
				id: input.resourceId,
				workspaceId: workspace.id,
				kind: "document",
				title: manifest.filename,
				status: "active",
				currentRevisionId: input.resourceId,
				updatedAt: manifest.createdAt,
			},
			revision: {
				...creator,
				id: input.resourceId,
				outputId: input.resourceId,
				revision: 1,
				content: JSON.stringify({
					kind: "document",
					blocks: [],
					file: { workspaceId: workspace.id, resourceId: input.resourceId },
				}),
				note: "Uploaded workspace file",
				// Uploaded bytes have no connected-source dependencies; file reads check workspace access.
				accessEnvelope: JSON.stringify({ version: 1, sources: [] }),
			},
		});
		const resource = await getOsWorkspaceResource(queryDb(context), {
			organizationId: organizationId,
			workspaceId: workspace.id,
			resourceId: input.resourceId,
		});
		if (!resource) missing();
		return {
			resource: mapWorkspaceResource(resource),
			outputId: input.resourceId,
		};
	},
);

export const getFile = read.resources.getFile.handler(
	async ({ input, context }) => {
		const organizationId = requireOrgId(context);
		await requireWorkspace(context, input.workspaceId);
		const resource = await getOsWorkspaceResource(queryDb(context), {
			organizationId: organizationId,
			...input,
		});
		if (
			!resource ||
			resource.status !== "active" ||
			resource.providerId !== "tedix" ||
			resource.resourceType !== "file"
		)
			missing();
		const manifest = await readWorkspaceFileManifest(
			context.env,
			organizationId,
			input.workspaceId,
			input.resourceId,
		);
		if (!manifest) missing();
		const exp = Math.floor(Date.now() / 1000) + 300;
		const sig = await workspaceFileSignature(
			context.env.SECRETS_MASTER_KEY,
			"read",
			organizationId,
			input.workspaceId,
			input.resourceId,
			exp,
		);
		return {
			filename: manifest.filename,
			mimeType: manifest.mimeType,
			size: manifest.size,
			url: `/api/workspace-files/${encodeURIComponent(organizationId)}/${input.workspaceId}/${input.resourceId}/media?exp=${exp}&sig=${sig}`,
			expiresAt: new Date(exp * 1000).toISOString(),
		};
	},
);
