import * as outputs from "./workspace-output-storage";
import { getOsOutput as getLegacyOutput } from "@tedix/db/queries/os-workspaces/outputs";
import { ORPCError } from "@orpc/server";
import { OS_OUTPUT_CONTENT_MAX_BYTES } from "@tedix/api-contract/utils/os-output-limits";
import { confirmOsWorkspaceFile as confirmFile } from "@tedix/db/queries/os-workspaces/files";
import { instantiateOsBlueprint as instantiateBlueprint } from "@tedix/db/queries/os-workspaces/instantiate";
import { env } from "cloudflare:workers";
import { notifyOutputRevision } from "./os-output-revision-notice";
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
import {
	outputRevisionChange,
	publishWorkspaceChangeSafely,
} from "./workspace-feed";

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
	if (new TextEncoder().encode(content).length > OS_OUTPUT_CONTENT_MAX_BYTES)
		throw new ORPCError("BAD_REQUEST", {
			message: `This file is over the ${OS_OUTPUT_CONTENT_MAX_BYTES / 1_000_000} MB limit. Remove or shrink large images.`,
		});
}

/**
 * The one place a revision body is stored. Images a writer embedded are
 * stored as assets of the file first, so the body carries references only;
 * `content` is the body as stored, which is what every caller gets back.
 */
async function storeRevisionBody(
	bucket: OutputStorageBucket,
	revision: { organizationId: string; outputId: string; content: string },
) {
	const content = await externalizeOutputAssets(
		{ organizationId: revision.organizationId, outputId: revision.outputId },
		revision.content,
		bucket,
	);
	requireStorableBody(content);
	return {
		content,
		body: await storeOutputRevisionBody(
			bucket,
			revision.organizationId,
			content,
		),
	};
}

export async function confirmOsWorkspaceFile(
	db: Parameters<typeof confirmFile>[0],
	params: Parameters<typeof confirmFile>[1],
	bucket: OutputStorageBucket = env.R2_BUCKET,
) {
	const revision = params.revision;
	if (!revision) return confirmFile(db, params);
	const { body } = await storeRevisionBody(bucket, revision);
	return confirmFile(db, {
		...params,
		revision: { ...revision, ...body, content: INLINE_BODY_OFFLOADED },
	});
}

/** Store every body before the blueprint's atomic D1 batch, including provisioning. */
export async function instantiateOsBlueprint(
	db: Parameters<typeof instantiateBlueprint>[0],
	params: Parameters<typeof instantiateBlueprint>[1],
	bucket: OutputStorageBucket = env.R2_BUCKET,
) {
	const storeRevisions = async (
		revisions: NonNullable<typeof params.outputRevisions>,
	) => {
		const stored = [];
		for (const revision of revisions) {
			if (revision.organizationId !== params.workspace.organizationId)
				throw new Error("Output revision scope mismatch");
			stored.push({
				...revision,
				...(await storeRevisionBody(bucket, revision)).body,
				content: INLINE_BODY_OFFLOADED,
			});
		}
		return stored;
	};
	const outputRevisions = await storeRevisions(params.outputRevisions ?? []);
	const provisioning = params.provisioning
		? {
				...params.provisioning,
				outputRevisions: await storeRevisions(
					params.provisioning.outputRevisions,
				),
			}
		: undefined;
	return instantiateBlueprint(db, { ...params, outputRevisions, provisioning });
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
	const { content, body } = await storeRevisionBody(bucket, revision);
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
	);
	await publishWorkspaceChangeSafely(
		{ db, queue: env.AUTOMATION_EVENTS },
		outputRevisionChange(created.output, { ...created.revision, content }),
	);
	return { ...created, revision: { ...created.revision, content } };
}

export async function createOsOutputRevision(
	db: Parameters<typeof outputs.createOsOutputRevision>[0],
	params: Parameters<typeof outputs.createOsOutputRevision>[1],
	bucket: OutputStorageBucket = env.R2_BUCKET,
) {
	const { content, body } = await storeRevisionBody(bucket, params);
	const result = await outputs.createOsOutputRevision(db, {
		...params,
		...body,
		content: INLINE_BODY_OFFLOADED,
	});
	if (result.ok) {
		const output = await outputs.getOsOutput(db, {
			organizationId: params.organizationId,
			outputId: params.outputId,
		});
		if (output) {
			await publishWorkspaceChangeSafely(
				{ db, queue: env.AUTOMATION_EVENTS },
				outputRevisionChange(output, { ...result.revision, content }),
			);
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

/** Collaboration keeps its existing atomic proposal/pointer/revision batch. */
export async function mergeOsCollaborationProposal(
	db: Parameters<typeof mergeProposal>[0],
	params: Parameters<typeof mergeProposal>[1],
	bucket: OutputStorageBucket = env.R2_BUCKET,
) {
	const proposal = await getOsCollaborationProposal(db, params);
	if (
		proposal?.documentType !== "output" ||
		proposal.status !== "accepted" ||
		proposal.sequence !== params.expectedSequence
	)
		return mergeProposal(db, params);
	if (
		!(await getLegacyOutput(db, {
			organizationId: proposal.organizationId,
			outputId: proposal.documentId,
		}))
	) {
		throw new ORPCError("NOT_IMPLEMENTED", {
			message:
				"Collaboration proposal merges for workspace-object outputs require the workspace merge protocol; direct editor revisions remain available",
		});
	}
	const { content, body } = await storeRevisionBody(bucket, {
		organizationId: proposal.organizationId,
		outputId: proposal.documentId,
		content: proposal.content,
	});
	const result = await mergeProposal(db, {
		...params,
		// The batch fences on the proposal's own bytes; the revision row keeps
		// only the pointer to the stored body.
		outputBody: { ...body, content: proposal.content },
	});
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
