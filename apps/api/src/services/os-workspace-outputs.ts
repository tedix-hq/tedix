import type { OsOutputRevisionRow } from "@tedix/db/tenant-store/outputs-schema";
import { requireSavableText } from "../lib/savable-text";
import { confirmWorkspaceFileResource } from "./workspace-resource-storage";
import {
	createInitializedWorkspace,
	workspaceDocumentRuntime,
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
	readOutputRevisionStorage,
	storeOutputRevisionBody,
	type OutputBodyBucket,
} from "./os-output-revision-body-store";
import {
	externalizeOutputAssets,
	type OutputAssetBucket,
} from "./os-output-assets";
import { excerptFromValue } from "./workspace-feed";
import { migrateSheetBlocks } from "@tedix/workspace-feed/sheet-block-migration";
import { sheetBlockManifest } from "@tedix/workspace-feed/sheet-blocks";

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
	db?: Parameters<typeof outputs.getOsOutput>[0],
) {
	let decoded: unknown = revision.content;
	let isJson = false;
	try {
		decoded = JSON.parse(revision.content);
		isJson = true;
	} catch {
		// Existing callers also store plain text bodies.
	}
	const sheet =
		typeof decoded === "object" &&
		decoded !== null &&
		"kind" in decoded &&
		decoded.kind === "sheet";
	if (sheet && !previous && db) {
		const output = await outputs.getOsOutput(db, {
			organizationId: revision.organizationId,
			outputId: revision.outputId,
		});
		if (output?.currentRevisionId)
			previous = await outputs.getOsOutputRevision(db, {
				organizationId: revision.organizationId,
				workspaceId: output.workspaceId ?? undefined,
				revisionId: output.currentRevisionId,
			});
	}
	// Verified bytes already belong to this file; CAS still checks the revision
	// and merges source requirements in the workspace object.
	if (
		previous?.organizationId === revision.organizationId &&
		previous.outputId === revision.outputId &&
		previous.content === revision.content &&
		previous.bodyR2Key &&
		previous.contentSha256 &&
		previous.contentBytes === requireStorableBody(revision.content).byteLength
	) {
		return {
			content: revision.content,
			parsedContent: isJson ? decoded : undefined,
			body: {
				bodyR2Key: previous.bodyR2Key,
				contentSha256: previous.contentSha256,
				contentBytes: previous.contentBytes,
			},
		};
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
		body:
			reusable && previous
				? {
						bodyR2Key: previous.bodyR2Key!,
						contentSha256: previous.contentSha256!,
						contentBytes: previous.contentBytes!,
					}
				: await storeOutputRevisionBody(
						bucket,
						revision.organizationId,
						bytes,
						sheet && previous?.bodyR2Key
							? (sheetBlockManifest(
									(
										await readOutputRevisionStorage(
											{ ...previous, content: "" },
											bucket,
										)
									).content,
								) ?? undefined)
							: undefined,
					),
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
		const scope = outputs.requireWorkspaceOutputScope(output);
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
	if (params.resources?.length) {
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

/** Legacy sheet bodies are converted before they can enter any edit path. */
export async function readStoredOutputRevision(
	db: Parameters<typeof outputs.getOsOutputRevision>[0],
	params: Parameters<typeof outputs.getOsOutputRevision>[1],
	bucket?: OutputBodyBucket,
	lap?: (stage: string) => void,
) {
	const row = await outputs.getOsOutputRevision(db, params);
	lap?.("baseLookupMs");
	if (!row) return undefined;
	return migrateSheetRevision(db, row, params.workspaceId, bucket);
}

async function migrateSheetRevision(
	db: Parameters<typeof outputs.getOsOutput>[0],
	row: OsOutputRevisionRow,
	workspaceId: string | undefined,
	bucket: OutputBodyBucket = env.R2_BUCKET,
	migrateInline = true,
) {
	const stored = await readOutputRevisionStorage(row, bucket);
	let content;
	try {
		content = JSON.parse(stored.content);
	} catch {
		return stored;
	}
	if (
		!(migrateInline && content?.kind === "sheet") &&
		content?.sheetBlocks !== 1
	)
		return stored;
	const migrated = await migrateSheetBlocks(
		bucket,
		row.organizationId,
		stored.content,
	);
	const body = await storeOutputRevisionBody(
		bucket,
		row.organizationId,
		migrated ? JSON.stringify(migrated) : stored.content,
	);
	const output = workspaceId
		? undefined
		: await outputs.getOsOutput(db, {
				organizationId: row.organizationId,
				outputId: row.outputId,
			});
	const bound = workspaceId ?? output?.workspaceId;
	if (!bound || !row.contentSha256)
		throw new Error(
			"Sheet migration requires a workspace and a verified revision body",
		);
	const changed = await workspaceDocumentRuntime().outputQuery(
		{ organizationId: row.organizationId, workspaceId: bound },
		{
			op: "rebody",
			revisionId: row.id,
			previousSha256: row.contentSha256,
			...body,
		},
	);
	if (!changed) {
		const current = await outputs.getOsOutputRevision(db, {
			organizationId: row.organizationId,
			workspaceId: bound,
			revisionId: row.id,
		});
		if (!current || current.contentSha256 !== body.contentSha256)
			throw new Error(
				"Sheet revision changed during migration; reopen the file",
			);
	}
	return readOutputRevisionStorage({ ...row, ...body, content: "" }, bucket);
}

export async function getOsOutputWithCurrentRevision(
	db: Parameters<typeof outputs.getOsOutputWithCurrentRevision>[0],
	params: Parameters<typeof outputs.getOsOutputWithCurrentRevision>[1],
	bucket?: OutputBodyBucket,
) {
	const result = await outputs.getOsOutputWithCurrentRevision(db, params);
	if (!result) return undefined;
	return {
		output: result.output,
		revision: await hydrateOutputRevision(
			await migrateSheetRevision(
				db,
				result.revision,
				params.workspaceId,
				bucket,
				false,
			),
			bucket,
		),
	};
}

export async function getOsOutputRevision(
	db: Parameters<typeof outputs.getOsOutputRevision>[0],
	params: Parameters<typeof outputs.getOsOutputRevision>[1],
	bucket?: OutputBodyBucket,
	lap?: (stage: string) => void,
) {
	const row = await outputs.getOsOutputRevision(db, params);
	lap?.("baseLookupMs");
	return row
		? hydrateOutputRevision(
				await migrateSheetRevision(db, row, params.workspaceId, bucket, false),
				bucket,
				lap,
			)
		: undefined;
}

export async function getOsOutputRevisionByNumber(
	db: Parameters<typeof outputs.getOsOutputRevisionByNumber>[0],
	params: Parameters<typeof outputs.getOsOutputRevisionByNumber>[1],
	bucket?: OutputBodyBucket,
) {
	const row = await outputs.getOsOutputRevisionByNumber(db, params);
	return row
		? hydrateOutputRevision(
				await migrateSheetRevision(db, row, params.workspaceId, bucket, false),
				bucket,
			)
		: undefined;
}

export async function getActiveSheetByTitle(
	db: Parameters<typeof outputs.getActiveSheetByTitle>[0],
	params: Parameters<typeof outputs.getActiveSheetByTitle>[1],
	bucket?: OutputBodyBucket,
) {
	const row = await outputs.getActiveSheetByTitle(db, params);
	return row
		? {
				...row,
				revision: await hydrateOutputRevision(
					await migrateSheetRevision(
						db,
						row.revision,
						params.workspaceId,
						bucket,
						false,
					),
					bucket,
				),
			}
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
	timing?: {
		lap: (stage: string) => void;
		waitUntil?: (promise: Promise<unknown>) => void;
	},
) {
	const { content, body, parsedContent } = await storeRevisionBody(
		bucket,
		params,
		previous,
		db,
	);
	timing?.lap("storeBodyMs");
	// The workspace publishes the save to its feed once, and decides itself
	// whether it continues a burst of auto-saves.
	const result = await outputs.createOsOutputRevision(
		db,
		{ ...params, ...body, content: INLINE_BODY_OFFLOADED },
		excerptFromValue(parsedContent),
		timing?.lap,
	);
	if (!result.ok) return result;
	const output =
		result.output ??
		(await outputs.getOsOutput(db, {
			organizationId: params.organizationId,
			outputId: params.outputId,
		}));
	if (output && result.revision.id === params.id) {
		const notice = notifyOutputRevision(
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
		if (timing?.waitUntil) timing.waitUntil(notice);
		else await notice;
	}
	timing?.lap("finishMs");
	// A no-op save returns the existing revision with the same body bytes.
	return { ...result, output, revision: { ...result.revision, content } };
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
