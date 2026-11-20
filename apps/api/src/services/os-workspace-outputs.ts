import type { OsOutputRevisionRow } from "@tedix/db/tenant-store/outputs-schema";
import { requireSavableText } from "../lib/savable-text";
import { confirmWorkspaceFileResource } from "./workspace-resource-storage";
import {
	createInitializedWorkspace,
	workspaceDocumentRuntime,
	workspaceOwnsDocuments,
} from "./workspace-document-owner";
import * as outputs from "./workspace-output-storage";
import { ORPCError } from "@orpc/server";
import { OS_OUTPUT_CONTENT_MAX_BYTES } from "@tedix/api-contract/utils/os-output-limits";
import type { confirmOsWorkspaceFile as confirmFile } from "@tedix/db/queries/os-workspaces/files";
import {
	instantiateOsBlueprint as instantiateBlueprint,
	prepareOsBlueprintWorkspace,
} from "@tedix/db/queries/os-workspaces/instantiate";
import { env } from "cloudflare:workers";
import { notifyOutputRevision } from "@tedix/workspace-feed/output-revision-notice";
import {
	getOsCollaborationProposal,
	mergeOsCollaborationProposal as mergeProposal,
} from "@tedix/db/queries/os-workspaces/collaboration";
import {
	hydrateOutputRevision,
	storeOutputRevisionBody,
	type OutputBodyBucket,
} from "./os-output-revision-body-store";
import {
	externalizeOutputAssets,
	type OutputAssetBucket,
} from "./os-output-assets";
import { excerptFromValue } from "./workspace-feed";

/**
 * Every writer stores the body in R2 first and leaves this sentinel in the
 * D1 row; `hydrateOutputRevision` reads the pointer. Inline bodies were the
 * largest growth driver of the main database (700 MB in November 2026).
 * Returned rows carry the stored bytes back so no writer re-reads R2.
 */
const INLINE_BODY_OFFLOADED = "";

type OutputStorageBucket = OutputBodyBucket &
	Pick<OutputAssetBucket, "put" | "head">;

/** Every new revision passes here, so one file cannot grow without bound. */
function requireStorableBody(content: string) {
	const bytes = new TextEncoder().encode(content);
	if (bytes.length > OS_OUTPUT_CONTENT_MAX_BYTES)
		throw new ORPCError("BAD_REQUEST", {
			message: `This file is over the ${OS_OUTPUT_CONTENT_MAX_BYTES / 1_000_000} MB limit. Remove or shrink large images.`,
		});
	return bytes;
}

/**
 * The one place a revision body is stored. Images a writer embedded are
 * stored as assets of the file first, so the body carries references only;
 * `content` is the body as stored, which is what every caller gets back.
 */
async function storeRevisionBody(
	bucket: OutputStorageBucket,
	revision: { organizationId: string; outputId: string; content: string },
	previous?: OsOutputRevisionRow,
) {
	let decoded: unknown = revision.content;
	let isJson = false;
	try {
		decoded = JSON.parse(revision.content);
		isJson = true;
	} catch {
		// Existing callers also store plain text bodies.
	}
	// JSON escapes preserve lone surrogates; inspect before any body or asset write.
	requireSavableText({ content: decoded });
	const content = await externalizeOutputAssets(
		{ organizationId: revision.organizationId, outputId: revision.outputId },
		revision.content,
		bucket,
	);
	const bytes = requireStorableBody(content);
	// Reuse the verified, durable base body; revision CAS still guards the save.
	const reusable =
		previous?.organizationId === revision.organizationId &&
		previous.outputId === revision.outputId &&
		previous.content === content &&
		previous.bodyR2Key &&
		previous.contentSha256 &&
		previous.contentBytes === bytes.byteLength;
	return {
		content,
		parsedContent: isJson
			? content === revision.content
				? decoded
				: JSON.parse(content)
			: undefined,
		body: reusable
			? {
					bodyR2Key: previous.bodyR2Key!,
					contentSha256: previous.contentSha256!,
					contentBytes: previous.contentBytes!,
				}
			: await storeOutputRevisionBody(bucket, revision.organizationId, bytes),
	};
}

export async function confirmOsWorkspaceFile(
	db: Parameters<typeof confirmFile>[0],
	params: Parameters<typeof confirmFile>[1],
	bucket: OutputStorageBucket = env.R2_BUCKET,
) {
	const { output, revision, resource } = params;
	if (output || revision) {
		if (
			!output ||
			!revision ||
			output.organizationId !== revision.organizationId ||
			output.id !== revision.outputId ||
			(resource &&
				(resource.organizationId !== output.organizationId ||
					resource.workspaceId !== output.workspaceId))
		)
			throw new Error("Output revision scope mismatch");
		const scope = await outputs.requireWorkspaceOutputAuthority(output);
		const { body } = await storeRevisionBody(bucket, revision);
		await outputs.ensureOsOutput(db, scope, output, {
			...revision,
			...body,
			content: INLINE_BODY_OFFLOADED,
		});
	}
	if (resource) return confirmWorkspaceFileResource(db, resource);
	if (!output) throw new Error("confirmOsWorkspaceFile needs a row to write");
	return { pendingProjection: undefined };
}

/** Object documents commit before shared provisioning and its replay receipt. */
export async function instantiateOsBlueprint(
	db: Parameters<typeof instantiateBlueprint>[0],
	params: Parameters<typeof instantiateBlueprint>[1],
	bucket: OutputStorageBucket = env.R2_BUCKET,
) {
	const documents = [
		...(params.outputs ?? []),
		...(params.provisioning?.outputs ?? []),
	];
	const revisions = [
		...(params.outputRevisions ?? []),
		...(params.provisioning?.outputRevisions ?? []),
	];
	const scope = {
		organizationId: params.workspace.organizationId,
		workspaceId: params.workspace.id,
	};
	const byId = new Map(revisions.map((revision) => [revision.id, revision]));
	const pairs = documents.map((output) => {
		const revision = output.currentRevisionId
			? byId.get(output.currentRevisionId)
			: undefined;
		if (
			!revision ||
			output.organizationId !== scope.organizationId ||
			output.workspaceId !== scope.workspaceId ||
			revision.organizationId !== scope.organizationId ||
			revision.outputId !== output.id
		)
			throw new Error("Output revision scope mismatch");
		return { output, revision };
	});
	if (
		pairs.length !== revisions.length ||
		byId.size !== revisions.length ||
		new Set(documents.map((output) => output.id)).size !== documents.length
	)
		throw new Error("Output revision scope mismatch");
	if (!pairs.length && !params.resources?.length)
		return createInitializedWorkspace(() => instantiateBlueprint(db, params));
	const workspace = await createInitializedWorkspace(() =>
		prepareOsBlueprintWorkspace(db, params.workspace),
	);
	if (pairs.length) await outputs.requireWorkspaceOutputAuthority(scope);
	if (params.resources?.length && (await workspaceOwnsDocuments(scope))) {
		for (const resource of params.resources)
			await workspaceDocumentRuntime().outputQuery(scope, {
				op: "resources",
				query: { operation: "ensure", params: resource },
			});
	}
	const stored = [];
	for (const { output, revision } of pairs)
		stored.push({
			output,
			revision: {
				...revision,
				...(await storeRevisionBody(bucket, revision)).body,
				content: INLINE_BODY_OFFLOADED,
			},
		});
	for (const { output, revision } of stored)
		await outputs.ensureOsOutput(db, scope, output, revision);
	// A failed object write must never leave a successful D1 replay receipt.
	return instantiateBlueprint(
		db,
		{
			...params,
			outputs: [],
			outputRevisions: [],
			provisioning: params.provisioning
				? { ...params.provisioning, outputs: [], outputRevisions: [] }
				: undefined,
		},
		workspace,
	);
}

export async function getOsOutputRevision(
	db: Parameters<typeof outputs.getOsOutputRevision>[0],
	params: Parameters<typeof outputs.getOsOutputRevision>[1],
	bucket?: OutputBodyBucket,
) {
	const row = await outputs.getOsOutputRevision(db, params);
	return row ? hydrateOutputRevision(row, bucket) : undefined;
}

export async function getOsOutputRevisionByNumber(
	db: Parameters<typeof outputs.getOsOutputRevisionByNumber>[0],
	params: Parameters<typeof outputs.getOsOutputRevisionByNumber>[1],
	bucket?: OutputBodyBucket,
) {
	const row = await outputs.getOsOutputRevisionByNumber(db, params);
	return row ? hydrateOutputRevision(row, bucket) : undefined;
}

export async function getActiveSheetByTitle(
	db: Parameters<typeof outputs.getActiveSheetByTitle>[0],
	params: Parameters<typeof outputs.getActiveSheetByTitle>[1],
	bucket?: OutputBodyBucket,
) {
	const row = await outputs.getActiveSheetByTitle(db, params);
	return row
		? { ...row, revision: await hydrateOutputRevision(row.revision, bucket) }
		: undefined;
}

export async function createOsOutput(
	db: Parameters<typeof outputs.createOsOutput>[0],
	output: Parameters<typeof outputs.createOsOutput>[2],
	revision: Parameters<typeof outputs.createOsOutput>[3],
	bucket: OutputStorageBucket = env.R2_BUCKET,
) {
	if (
		output.organizationId !== revision.organizationId ||
		output.id !== revision.outputId
	)
		throw new Error("Output revision scope mismatch");
	const { content, body, parsedContent } = await storeRevisionBody(
		bucket,
		revision,
	);
	const created = await outputs.createOsOutput(
		db,
		{
			organizationId: output.organizationId,
			workspaceId: output.workspaceId ?? undefined,
		},
		output,
		{
			...revision,
			...body,
			content: INLINE_BODY_OFFLOADED,
		},
		// The workspace publishes the save to its feed once, with this text.
		excerptFromValue(parsedContent),
	);
	return { ...created, revision: { ...created.revision, content } };
}

export async function createOsOutputRevision(
	db: Parameters<typeof outputs.createOsOutputRevision>[0],
	params: Parameters<typeof outputs.createOsOutputRevision>[1],
	bucket: OutputStorageBucket = env.R2_BUCKET,
	previous?: OsOutputRevisionRow,
) {
	const { content, body, parsedContent } = await storeRevisionBody(
		bucket,
		params,
		previous,
	);
	// The workspace publishes the save to its feed once, and decides itself
	// whether it continues a burst of auto-saves.
	const result = await outputs.createOsOutputRevision(
		db,
		{ ...params, ...body, content: INLINE_BODY_OFFLOADED },
		excerptFromValue(parsedContent),
	);
	if (result.ok) {
		const output = await outputs.getOsOutput(db, {
			organizationId: params.organizationId,
			outputId: params.outputId,
		});
		if (output) {
			// Everyone with the file open learns of the new revision at once and
			// fetches only what changed.
			await notifyOutputRevision(
				{
					db,
					rooms: env.APP_DRAFT_ROOM,
					env,
					development: env.ENVIRONMENT === "development",
				},
				output,
				{
					outputId: output.id,
					revisionId: result.revision.id,
					revision: result.revision.revision,
				},
			);
		}
	}
	// An unchanged save returns the current revision; its digest equals this
	// stored body's, so these bytes are the row's bytes either way.
	return result.ok
		? { ...result, revision: { ...result.revision, content } }
		: result;
}

/** Commit the object revision before the shared collaboration receipt. */
export async function mergeOsCollaborationProposal(
	db: Parameters<typeof mergeProposal>[0],
	params: Parameters<typeof mergeProposal>[1],
	bucket: OutputStorageBucket = env.R2_BUCKET,
) {
	const proposal = await getOsCollaborationProposal(db, params);
	if (
		proposal?.documentType !== "output" ||
		(proposal.status !== "accepted" && proposal.status !== "merged") ||
		proposal.sequence !== params.expectedSequence
	)
		return mergeProposal(db, params);
	await outputs.requireWorkspaceOutputAuthority(proposal);
	const { content, body } = await storeRevisionBody(bucket, {
		organizationId: proposal.organizationId,
		outputId: proposal.documentId,
		content: proposal.content,
	});
	const result = await mergeProposal(
		db,
		{
			...params,
			outputBody: { ...body, content: proposal.content },
		},
		outputs.commitCollaborationOutput,
	);
	if (result.ok && "id" in result.revision) {
		const output = await outputs.getOsOutput(db, {
			organizationId: proposal.organizationId,
			outputId: proposal.documentId,
		});
		if (output)
			await notifyOutputRevision(
				{
					db,
					rooms: env.APP_DRAFT_ROOM,
					env,
					development: env.ENVIRONMENT === "development",
				},
				output,
				{
					outputId: output.id,
					revisionId: result.revision.id,
					revision: result.revision.revision,
				},
			);
	}
	return result.ok
		? { ...result, revision: { ...result.revision, content } }
		: result;
}
