import * as outputs from "@tedix/db/queries/os-workspaces/outputs";
import { confirmOsWorkspaceFile as confirmFile } from "@tedix/db/queries/os-workspaces/files";
import { instantiateOsBlueprint as instantiateBlueprint } from "@tedix/db/queries/os-workspaces/instantiate";
import { env } from "cloudflare:workers";
import {
	getOsCollaborationProposal,
	mergeOsCollaborationProposal as mergeProposal,
} from "@tedix/db/queries/os-workspaces/collaboration";
import {
	hydrateOutputRevision,
	storeOutputRevisionBody,
	type OutputBodyBucket,
} from "./os-output-revision-body-store";

/**
 * Every writer stores the body in R2 first and leaves this sentinel in the
 * D1 row; `hydrateOutputRevision` reads the pointer. Inline bodies were the
 * largest growth driver of the main database (700 MB in November 2026).
 * Returned rows carry the caller's bytes back so no writer re-reads R2.
 */
const INLINE_BODY_OFFLOADED = "";

export async function confirmOsWorkspaceFile(
	db: Parameters<typeof confirmFile>[0],
	params: Parameters<typeof confirmFile>[1],
	bucket: OutputBodyBucket = env.R2_BUCKET,
) {
	const revision = params.revision;
	if (!revision) return confirmFile(db, params);
	const body = await storeOutputRevisionBody(
		bucket,
		revision.organizationId,
		revision.content,
	);
	return confirmFile(db, {
		...params,
		revision: { ...revision, ...body, content: INLINE_BODY_OFFLOADED },
	});
}

/** Store every body before the blueprint's atomic D1 batch, including provisioning. */
export async function instantiateOsBlueprint(
	db: Parameters<typeof instantiateBlueprint>[0],
	params: Parameters<typeof instantiateBlueprint>[1],
	bucket: OutputBodyBucket = env.R2_BUCKET,
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
				...(await storeOutputRevisionBody(
					bucket,
					revision.organizationId,
					revision.content,
				)),
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
	output: Parameters<typeof outputs.createOsOutput>[1],
	revision: Parameters<typeof outputs.createOsOutput>[2],
	bucket: OutputBodyBucket = env.R2_BUCKET,
) {
	if (
		output.organizationId !== revision.organizationId ||
		output.id !== revision.outputId
	)
		throw new Error("Output revision scope mismatch");
	const body = await storeOutputRevisionBody(
		bucket,
		revision.organizationId,
		revision.content,
	);
	const created = await outputs.createOsOutput(db, output, {
		...revision,
		...body,
		content: INLINE_BODY_OFFLOADED,
	});
	return {
		...created,
		revision: { ...created.revision, content: revision.content },
	};
}

export async function createOsOutputRevision(
	db: Parameters<typeof outputs.createOsOutputRevision>[0],
	params: Parameters<typeof outputs.createOsOutputRevision>[1],
	bucket: OutputBodyBucket = env.R2_BUCKET,
) {
	const body = await storeOutputRevisionBody(
		bucket,
		params.organizationId,
		params.content,
	);
	const result = await outputs.createOsOutputRevision(db, {
		...params,
		...body,
		content: INLINE_BODY_OFFLOADED,
	});
	// An unchanged save returns the current revision; its digest equals this
	// body's, so the caller's bytes are the row's bytes either way.
	return result.ok
		? { ...result, revision: { ...result.revision, content: params.content } }
		: result;
}

/** Collaboration keeps its existing atomic proposal/pointer/revision batch. */
export async function mergeOsCollaborationProposal(
	db: Parameters<typeof mergeProposal>[0],
	params: Parameters<typeof mergeProposal>[1],
	bucket: OutputBodyBucket = env.R2_BUCKET,
) {
	const proposal = await getOsCollaborationProposal(db, params);
	if (
		proposal?.documentType !== "output" ||
		proposal.status !== "accepted" ||
		proposal.sequence !== params.expectedSequence
	)
		return mergeProposal(db, params);
	const body = await storeOutputRevisionBody(
		bucket,
		proposal.organizationId,
		proposal.content,
	);
	const result = await mergeProposal(db, {
		...params,
		outputBody: { ...body, content: proposal.content },
	});
	return result.ok
		? { ...result, revision: { ...result.revision, content: proposal.content } }
		: result;
}
