import { implement } from "@orpc/server";
import { osWorkspacesContract } from "@tedix/api-contract/contracts/os-workspaces";
import {
	WORKSPACE_FILE_PART_BYTES,
	workspaceFileReadAction,
	type WorkspaceChatFileInput,
	type WorkspaceFilePart,
	workspaceFileKey,
	type WorkspaceFileManifest,
} from "@tedix/api-contract/schemas/workspace-files";
import { confirmOsWorkspaceFile } from "../../services/os-workspace-outputs";
import { attachOutputEditor } from "../../services/os-output-editor";
import { getOsOutput } from "../../services/workspace-output-storage";
import { requireUnrestrictedModelEgress } from "../../services/unrouted-model-egress";
import {
	ensureResourceProjection,
	getOsWorkspaceResource,
	retryResourceProjection,
} from "../../services/workspace-resource-storage";
import { getOsWorkspaceResource as getResourceListCopy } from "@tedix/db/queries/os-workspaces/resources";
import type { OsDocumentBlock } from "@tedix/api-contract/schemas/os-workspaces";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
} from "../orpc";
import { withOrg } from "../org-scope";
import { OS_WORKSPACES_AUDIT, osAudit } from "../os-audit";
import {
	queryDb,
	requireWorkspace,
	resolveCreator,
} from "./os-workspaces-shared";
import { mapWorkspaceResource } from "./os-workspace-resources";
import {
	readWorkspaceFileManifest,
	workspaceFileSignature,
	workspaceFileMimeMatches,
	readWorkspaceFileContent,
	storeWorkspaceFileText,
	type PdfToMarkdown,
} from "../../lib/workspace-files";

const os = implement(osWorkspacesContract)
	.$context<BaseContext>()
	.use(withAuth)
	.use(osAudit(OS_WORKSPACES_AUDIT));
const author = os.use(AUTHZ.osAuthor);
const read = os.use(AUTHZ.osRead);
/** PDF text through the model converter, only where the organization's data rules allow it. */
function pdfConverter(
	context: BaseContext,
	organizationId: string,
): PdfToMarkdown | undefined {
	const ai = context.env.AI;
	if (!ai) return undefined;
	return async (bytes, name) => {
		await requireUnrestrictedModelEgress(
			context.db,
			organizationId,
			"PDF text reading",
			context.env.DB,
		);
		const converted = await ai.toMarkdown({
			name,
			blob: new Blob([bytes], { type: "application/pdf" }),
		});
		if (converted.format === "error")
			throw createError(ErrorCodes.BAD_GATEWAY, "PDF text conversion failed");
		return converted.data;
	};
}

/** Read an uploaded file, keep its whole text for the agent, and return the start for its document. */
async function readAndKeepFileText(
	context: BaseContext,
	file: { organizationId: string; workspaceId: string; resourceId: string },
	manifest: WorkspaceFileManifest,
	chatOnly?: true,
) {
	const content = await readWorkspaceFileContent(
		context.env,
		workspaceFileKey(file.organizationId, file.workspaceId, file.resourceId),
		manifest,
		pdfConverter(context, file.organizationId),
	);
	await storeWorkspaceFileText(context.env, file, content.text, chatOnly);
	return content.blocks;
}

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

/**
 * The document Output and first revision a confirmed file may publish. The
 * file's readable text rides on its reference, so agents and readers see the
 * contents while the document stays a read-only preview of the file.
 */
function fileDocumentRows(
	creator: {
		organizationId: string;
		createdByKind: WorkspaceFileManifest["createdByKind"];
		createdById: string;
		createdAt: string;
	},
	workspaceId: string,
	resourceId: string,
	title: string,
	extract: OsDocumentBlock[] = [],
) {
	return {
		output: {
			...creator,
			id: resourceId,
			workspaceId,
			kind: "document" as const,
			title,
			status: "active" as const,
			currentRevisionId: resourceId,
			updatedAt: creator.createdAt,
		},
		revision: {
			...creator,
			id: resourceId,
			outputId: resourceId,
			revision: 1,
			content: JSON.stringify({
				kind: "document",
				blocks: [],
				file: {
					workspaceId,
					resourceId,
					...(extract.length ? { extract } : {}),
				},
			}),
			note: "Uploaded workspace file",
			// Uploaded bytes have no connected-source dependencies; file reads check workspace access.
			accessEnvelope: JSON.stringify({ version: 1, sources: [] }),
		},
	};
}

/**
 * Publish the document Output for a resource that was retained without one.
 * The insert is conflict-idempotent, so a parallel confirm stays safe.
 */
async function ensureWorkspaceFileDocument(
	context: BaseContext,
	workspaceId: string,
	manifest: WorkspaceFileManifest,
	resourceId: string,
): Promise<string> {
	const db = queryDb(context);
	const existing = await getOsOutput(db, {
		organizationId: manifest.organizationId,
		outputId: resourceId,
	});
	if (!existing) {
		await confirmOsWorkspaceFile(
			db,
			fileDocumentRows(
				{
					organizationId: manifest.organizationId,
					createdByKind: manifest.createdByKind,
					createdById: manifest.createdById,
					createdAt: manifest.createdAt,
				},
				workspaceId,
				resourceId,
				manifest.filename,
				await readAndKeepFileText(
					context,
					{
						organizationId: manifest.organizationId,
						workspaceId,
						resourceId,
					},
					manifest,
				),
			),
		);
	}
	await attachFileDocumentEditor(
		context,
		manifest.organizationId,
		workspaceId,
		resourceId,
	);
	return resourceId;
}

/** A file document opens read-only in the Doc gadget, like any document. */
function attachFileDocumentEditor(
	context: BaseContext,
	organizationId: string,
	workspaceId: string,
	outputId: string,
) {
	return attachOutputEditor(context, {
		id: outputId,
		organizationId,
		workspaceId,
		kind: "document",
	});
}

async function validateUploadedFile(
	context: BaseContext,
	manifest: WorkspaceFileManifest,
	parts: WorkspaceFilePart[],
) {
	const key = workspaceFileKey(
		manifest.organizationId,
		manifest.workspaceId,
		manifest.resourceId,
	);
	if (manifest.chatOnly && manifest.mimeValidated) return;
	if (Date.parse(manifest.expiresAt) <= Date.now())
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Upload expired; request a new upload",
		);
	const count = Math.ceil(manifest.size / WORKSPACE_FILE_PART_BYTES);
	if (
		parts.length !== count ||
		parts.some((part, index) => part.partNumber !== index + 1)
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
			).complete(parts);
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
	const prefix = await context.env.SKILL_ARTIFACTS.get(key, {
		range: { offset: 0, length: Math.min(manifest.size, 512) },
	});
	if (!prefix) missing();
	manifest.mimeType = workspaceFileMimeMatches(
		manifest.mimeType,
		new Uint8Array(await prefix.arrayBuffer()),
	)
		? manifest.mimeType
		: "application/octet-stream";
	manifest.mimeValidated = true;
	await context.env.SKILL_ARTIFACTS.put(
		`${key}.json`,
		JSON.stringify(manifest),
	);
}

async function publishWorkspaceFile(
	context: BaseContext,
	manifest: WorkspaceFileManifest,
	document: boolean,
	parts?: WorkspaceFilePart[],
) {
	const { organizationId, workspaceId, resourceId } = manifest;
	const existing = await getOsWorkspaceResource(queryDb(context), {
		organizationId: organizationId,
		workspaceId: workspaceId,
		resourceId: resourceId,
	});
	if (existing) {
		if (
			existing.status !== "active" ||
			existing.providerId !== "tedix" ||
			existing.resourceType !== "file"
		)
			missing();
		await ensureResourceProjection(queryDb(context), existing);
		return {
			resource: mapWorkspaceResource(existing),
			...(document
				? {
						outputId: await ensureWorkspaceFileDocument(
							context,
							workspaceId,
							manifest,
							existing.id,
						),
					}
				: {}),
		};
	}
	if (parts) await validateUploadedFile(context, manifest, parts);
	const creator = {
		organizationId: organizationId,
		createdByKind: manifest.createdByKind,
		createdById: manifest.createdById,
		createdAt: manifest.createdAt,
	};
	const { pendingProjection } = await confirmOsWorkspaceFile(queryDb(context), {
		resource: {
			...creator,
			id: resourceId,
			workspaceId: workspaceId,
			providerId: "tedix",
			connectionScope: "tenant",
			requiredScopes: "[]",
			resourceType: "file",
			providerResourceId: resourceId,
			name: manifest.filename,
			metadata: JSON.stringify({
				mimeType: manifest.mimeType,
				size: manifest.size,
			}),
			status: "active",
			updatedAt: manifest.createdAt,
		},
		...(document
			? fileDocumentRows(
					creator,
					workspaceId,
					resourceId,
					manifest.filename,
					await readAndKeepFileText(
						context,
						{
							organizationId,
							workspaceId: workspaceId,
							resourceId: resourceId,
						},
						manifest,
					),
				)
			: {}),
	});
	const resource = await getOsWorkspaceResource(queryDb(context), {
		organizationId: organizationId,
		workspaceId: workspaceId,
		resourceId: resourceId,
	});
	if (!resource) missing();
	if (pendingProjection)
		context.waitUntil?.(
			retryResourceProjection(queryDb(context), pendingProjection),
		);
	if (document)
		await attachFileDocumentEditor(
			context,
			organizationId,
			workspaceId,
			resourceId,
		);
	return {
		resource: mapWorkspaceResource(resource),
		...(document ? { outputId: resourceId } : {}),
	};
}

export const confirmFileUpload = author.resources.confirmFileUpload.handler(
	async ({ input, context }) => {
		const workspace = await requireWorkspace(context, input.workspaceId);
		const manifest = await readWorkspaceFileManifest(
			context.env,
			workspace.organizationId,
			workspace.id,
			input.resourceId,
		);
		if (!manifest || manifest.chatOnly) missing();
		return publishWorkspaceFile(
			context,
			manifest,
			input.document === true,
			input.parts,
		);
	},
);

export const confirmChatFileUpload =
	author.resources.confirmChatFileUpload.handler(async ({ input, context }) => {
		const workspace = await requireWorkspace(context, input.workspaceId);
		const uploader = resolveCreator(context);
		const manifest = await readWorkspaceFileManifest(
			context.env,
			workspace.organizationId,
			workspace.id,
			input.resourceId,
		);
		if (
			!manifest?.chatOnly ||
			manifest.createdByKind !== uploader.kind ||
			manifest.createdById !== uploader.id
		)
			missing();
		if (!manifest.chatReady) {
			await validateUploadedFile(context, manifest, input.parts);
			await readAndKeepFileText(context, manifest, manifest, true);
			manifest.chatReady = true;
			const key = workspaceFileKey(
				manifest.organizationId,
				manifest.workspaceId,
				manifest.resourceId,
			);
			await context.env.SKILL_ARTIFACTS.put(
				`${key}.json`,
				JSON.stringify(manifest),
			);
		}
		return {
			resourceId: manifest.resourceId,
			filename: manifest.filename,
			mimeType: manifest.mimeType,
			size: manifest.size,
		};
	});

/** A file ID is not sufficient to read or publish a chat upload. */
async function requireChatFile(
	context: BaseContext,
	organizationId: string,
	input: WorkspaceChatFileInput,
) {
	const scope = { organizationId, workspaceId: input.workspaceId };
	const { conversationId, seq } = input.chat;
	const runtime = context.env.WORKSPACE_RUNTIME as unknown as {
		hasConversation(
			scope: { organizationId: string; workspaceId: string },
			id: string,
		): Promise<boolean>;
		readEvents(
			scope: { organizationId: string; workspaceId: string },
			input: { conversationId: string; after: number; limit: number },
		): Promise<unknown[]>;
	};
	if (!(await runtime.hasConversation(scope, conversationId))) missing();
	const events = await runtime.readEvents(scope, {
		conversationId,
		after: seq - 1,
		limit: 1,
	});
	const event = events[0] as
		| {
				conversationId?: string;
				seq?: number;
				type?: string;
				attachments?: Array<{ outputId: string; chatOnly?: boolean }>;
		  }
		| undefined;
	if (
		event?.seq !== seq ||
		event.conversationId !== conversationId ||
		![
			"turn.started",
			"message.queued",
			"message.read",
			"message.returned",
		].includes(event.type ?? "") ||
		!event.attachments?.some(
			(file) => file.chatOnly && file.outputId === input.resourceId,
		)
	)
		missing();
	const manifest = await readWorkspaceFileManifest(
		context.env,
		organizationId,
		input.workspaceId,
		input.resourceId,
	);
	if (!manifest?.chatOnly || !manifest.chatReady) missing();
	return manifest;
}

export const saveChatFile = author.resources.saveChatFile.handler(
	async ({ input, context }) => {
		const workspace = await requireWorkspace(context, input.workspaceId);
		const manifest = await requireChatFile(
			context,
			workspace.organizationId,
			input,
		);
		await publishWorkspaceFile(context, manifest, true);
		return { outputId: manifest.resourceId };
	},
);

export const getFile = read.resources.getFile
	.use(withOrg)
	.handler(async ({ input, context }) => {
		const organizationId = context.organizationId;
		await requireWorkspace(context, input.workspaceId);
		const { workspaceId, resourceId, chat } = input;
		let manifest: WorkspaceFileManifest | null;
		if (chat) {
			manifest = await requireChatFile(context, organizationId, {
				workspaceId,
				resourceId,
				chat,
			});
		} else {
			const resource = await getResourceListCopy(queryDb(context), {
				organizationId,
				workspaceId,
				resourceId,
			});
			if (
				!resource ||
				resource.status !== "active" ||
				resource.providerId !== "tedix" ||
				resource.resourceType !== "file"
			)
				missing();
			manifest = await readWorkspaceFileManifest(
				context.env,
				organizationId,
				workspaceId,
				resourceId,
			);
			if (!manifest) missing();
		}
		const exp = Math.floor(Date.now() / 1000) + 300;
		const sig = await workspaceFileSignature(
			context.env.SECRETS_MASTER_KEY,
			workspaceFileReadAction(chat),
			organizationId,
			input.workspaceId,
			input.resourceId,
			exp,
		);
		const query = new URLSearchParams({ exp: String(exp), sig });
		if (chat) {
			query.set("conversation", chat.conversationId);
			query.set("seq", String(chat.seq));
		}
		return {
			filename: manifest.filename,
			mimeType: manifest.mimeValidated
				? manifest.mimeType
				: "application/octet-stream",
			size: manifest.size,
			url: `/api/workspace-files/${encodeURIComponent(organizationId)}/${input.workspaceId}/${input.resourceId}/media?${query}`,
			expiresAt: new Date(exp * 1000).toISOString(),
		};
	});
