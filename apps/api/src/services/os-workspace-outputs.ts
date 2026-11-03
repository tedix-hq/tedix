import * as outputs from "@tedix/db/queries/os-workspaces/outputs";
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
	return outputs.createOsOutput(db, output, { ...revision, ...body });
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
	});
	return result.ok
		? {
				...result,
				revision: await hydrateOutputRevision(result.revision, bucket),
			}
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
	return mergeProposal(db, {
		...params,
		outputBody: { ...body, content: proposal.content },
	});
}
