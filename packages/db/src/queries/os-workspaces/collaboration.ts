import {
	OsAppDraftContentSchema,
	type OsAppDraftContent,
} from "@tedix/api-contract/schemas/os-workspaces";
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import {
	type NewOsCollaborationProposalRow,
	type OsCollaborationProposalRow,
	type OsGadgetRevisionRow,
	type OsOutputRevisionRow,
	osCollaborationProposals,
	osGadgetRevisions,
	osGadgetCode,
	osGadgetCodeBlobs,
	osGadgetExecutions,
	osGadgets,
} from "../../schema/os-workspaces";
import { normalizeStoredJsonText } from "../../utils/json";
import { announceOsWorkspaceChange } from "../os-workspace-events";
import { getOsGadgetRevision } from "./gadgets";
import { workspaceOutputIndex } from "../../schema/workspace-feed";
import { mergeOsOutputAccessEnvelopes } from "../../utils/os-output-access-envelope";
import { chunkForBoundParams } from "../../utils/batch";
import {
	buildOsGadgetRevisionCodeStatements,
	osGadgetCodeSha256,
} from "./gadget-code";

export interface OsCollaborationProposalScope {
	organizationId: string;
	proposalId: string;
}

export interface ListOsCollaborationProposalsOptions {
	workspaceId?: string;
	documentType?: OsCollaborationProposalRow["documentType"];
	documentId?: string;
	statuses?: OsCollaborationProposalRow["status"][];
	sourceKind?: OsCollaborationProposalRow["sourceKind"];
	sourceId?: string;
	limit?: number;
}

async function createOsCollaborationProposalUnannounced(
	db: DbQueryClient,
	proposal: NewOsCollaborationProposalRow,
): Promise<OsCollaborationProposalRow> {
	const [row] = await db
		.insert(osCollaborationProposals)
		.values(proposal)
		.returning();
	if (!row) throw new Error("OS collaboration proposal insert returned no row");
	return row;
}

export async function createOsCollaborationProposal(
	db: DbQueryClient,
	proposal: NewOsCollaborationProposalRow,
): Promise<OsCollaborationProposalRow> {
	const result = await createOsCollaborationProposalUnannounced(db, proposal);
	if (result && "workspaceId" in result) {
		await announceOsWorkspaceChange(
			db,
			result.workspaceId,
			result.documentType === "gadget" ? "drafts" : "proposals",
		);
	}
	return result;
}

export async function getOsCollaborationProposal(
	db: DbQueryClient,
	params: OsCollaborationProposalScope,
): Promise<OsCollaborationProposalRow | undefined> {
	const [row] = await db
		.select()
		.from(osCollaborationProposals)
		.where(
			and(
				eq(osCollaborationProposals.organizationId, params.organizationId),
				eq(osCollaborationProposals.id, params.proposalId),
			),
		)
		.limit(1);
	return row;
}

export async function listOsCollaborationProposals(
	db: DbQueryClient,
	organizationId: string,
	options: ListOsCollaborationProposalsOptions = {},
): Promise<OsCollaborationProposalRow[]> {
	const conditions = [
		eq(osCollaborationProposals.organizationId, organizationId),
	];
	if (options.workspaceId) {
		conditions.push(
			eq(osCollaborationProposals.workspaceId, options.workspaceId),
		);
	}
	if (options.documentType) {
		conditions.push(
			eq(osCollaborationProposals.documentType, options.documentType),
		);
	}
	if (options.documentId) {
		conditions.push(
			eq(osCollaborationProposals.documentId, options.documentId),
		);
	}
	if (options.sourceKind)
		conditions.push(
			eq(osCollaborationProposals.sourceKind, options.sourceKind),
		);
	if (options.sourceId)
		conditions.push(eq(osCollaborationProposals.sourceId, options.sourceId));
	if (options.statuses && options.statuses.length > 0) {
		// bound-params: subset of the closed proposal-status enum
		conditions.push(inArray(osCollaborationProposals.status, options.statuses));
	}
	return db
		.select()
		.from(osCollaborationProposals)
		.where(and(...conditions))
		.orderBy(
			desc(osCollaborationProposals.updatedAt),
			desc(osCollaborationProposals.id),
		)
		.limit(Math.min(Math.max(options.limit ?? 50, 1), 200));
}

/**
 * Which of `ids` have retained collaboration proposals: workspace ids when
 * `by` is "workspace", output document ids when it is "output".
 */
export async function listOsIdsWithCollaborationProposals(
	db: DbQueryClient,
	params: { organizationId: string; by: "workspace" | "output"; ids: string[] },
): Promise<Set<string>> {
	const found = new Set<string>();
	for (const chunk of chunkForBoundParams(params.ids, 90)) {
		const rows =
			params.by === "workspace"
				? await db
						.selectDistinct({ id: osCollaborationProposals.workspaceId })
						.from(osCollaborationProposals)
						.where(
							and(
								eq(
									osCollaborationProposals.organizationId,
									params.organizationId,
								),
								inArray(osCollaborationProposals.workspaceId, chunk),
							),
						)
				: await db
						.selectDistinct({ id: osCollaborationProposals.documentId })
						.from(osCollaborationProposals)
						.where(
							and(
								eq(
									osCollaborationProposals.organizationId,
									params.organizationId,
								),
								eq(osCollaborationProposals.documentType, "output"),
								inArray(osCollaborationProposals.documentId, chunk),
							),
						);
		for (const row of rows) if (row.id) found.add(row.id);
	}
	return found;
}

async function updateOsCollaborationProposalPreviewUnannounced(
	db: DbQueryClient,
	params: OsCollaborationProposalScope & {
		expectedSequence: number;
		content: string;
		sourceKind: OsCollaborationProposalRow["sourceKind"];
		sourceId: string;
	},
): Promise<OsCollaborationProposalRow | undefined> {
	const [row] = await db
		.update(osCollaborationProposals)
		.set({
			content: params.content,
			sequence: sql`${osCollaborationProposals.sequence} + 1`,
			updatedAt: new Date().toISOString(),
		})
		.where(
			and(
				eq(osCollaborationProposals.organizationId, params.organizationId),
				eq(osCollaborationProposals.id, params.proposalId),
				eq(osCollaborationProposals.status, "open"),
				eq(osCollaborationProposals.sequence, params.expectedSequence),
				eq(osCollaborationProposals.sourceAttestationVersion, 1),
				eq(osCollaborationProposals.sourceKind, params.sourceKind),
				eq(osCollaborationProposals.sourceId, params.sourceId),
			),
		)
		.returning();
	return row;
}

export async function updateOsCollaborationProposalPreview(
	db: DbQueryClient,
	params: OsCollaborationProposalScope & {
		expectedSequence: number;
		content: string;
		sourceKind: OsCollaborationProposalRow["sourceKind"];
		sourceId: string;
	},
): Promise<OsCollaborationProposalRow | undefined> {
	const result = await updateOsCollaborationProposalPreviewUnannounced(
		db,
		params,
	);
	if (result && "workspaceId" in result) {
		await announceOsWorkspaceChange(
			db,
			result.workspaceId,
			result.documentType === "gadget" ? "drafts" : "proposals",
		);
	}
	return result;
}

async function rebaseOsAppDraftUnannounced(
	db: DbQueryClient,
	params: OsCollaborationProposalScope & {
		expectedSequence: number;
		baseRevisionId: string;
		baseRevision: number;
		content: string;
	},
): Promise<OsCollaborationProposalRow | undefined> {
	const [row] = await db
		.update(osCollaborationProposals)
		.set({
			content: params.content,
			baseRevisionId: params.baseRevisionId,
			baseRevision: params.baseRevision,
			status: "open",
			sequence: sql`${osCollaborationProposals.sequence} + 1`,
			decisionRationale: null,
			decisionEvidenceRefs: "[]",
			decidedByKind: null,
			decidedById: null,
			decidedAt: null,
			updatedAt: new Date().toISOString(),
		})
		.where(
			and(
				eq(osCollaborationProposals.organizationId, params.organizationId),
				eq(osCollaborationProposals.id, params.proposalId),
				eq(osCollaborationProposals.documentType, "gadget"),
				inArray(osCollaborationProposals.status, ["open", "accepted"]),
				eq(osCollaborationProposals.sequence, params.expectedSequence),
			),
		)
		.returning();
	return row;
}

export async function rebaseOsAppDraft(
	db: DbQueryClient,
	params: OsCollaborationProposalScope & {
		expectedSequence: number;
		baseRevisionId: string;
		baseRevision: number;
		content: string;
	},
): Promise<OsCollaborationProposalRow | undefined> {
	const result = await rebaseOsAppDraftUnannounced(db, params);
	if (result && "workspaceId" in result) {
		await announceOsWorkspaceChange(
			db,
			result.workspaceId,
			result.documentType === "gadget" ? "drafts" : "proposals",
		);
	}
	return result;
}

type StaleProposalResult = { reason: "stale_base" };

/** Compare every intervening revision, including changes later reverted. */
async function rebaseStaleAppProposal(
	db: DbQueryClient,
	proposal: OsCollaborationProposalRow,
	currentRevisionId: string,
): Promise<
	| Pick<
			OsCollaborationProposalRow,
			"content" | "baseRevisionId" | "baseRevision"
	  >
	| StaleProposalResult
> {
	const stale = { reason: "stale_base" } as const;
	const current = await getOsGadgetRevision(db, {
		organizationId: proposal.organizationId,
		revisionId: currentRevisionId,
	});
	const draft = OsAppDraftContentSchema.safeParse(JSON.parse(proposal.content));
	if (!current || current.gadgetId !== proposal.documentId || !draft.success)
		return stale;
	const history = await db
		.select({
			id: osGadgetRevisions.id,
			revision: osGadgetRevisions.revision,
			manifest: osGadgetRevisions.manifest,
			files: osGadgetCodeBlobs.files,
		})
		.from(osGadgetRevisions)
		.leftJoin(
			osGadgetCode,
			and(
				eq(osGadgetCode.revisionId, osGadgetRevisions.id),
				eq(osGadgetCode.organizationId, osGadgetRevisions.organizationId),
			),
		)
		.leftJoin(
			osGadgetCodeBlobs,
			and(
				eq(osGadgetCodeBlobs.organizationId, osGadgetCode.organizationId),
				eq(osGadgetCodeBlobs.sha256, osGadgetCode.filesSha256),
			),
		)
		.where(
			and(
				eq(osGadgetRevisions.organizationId, proposal.organizationId),
				eq(osGadgetRevisions.gadgetId, proposal.documentId),
				gte(osGadgetRevisions.revision, proposal.baseRevision),
				lte(osGadgetRevisions.revision, current.revision),
			),
		)
		.orderBy(asc(osGadgetRevisions.revision));
	if (
		history[0]?.id !== proposal.baseRevisionId ||
		history.at(-1)?.id !== current.id ||
		history.length !== current.revision - proposal.baseRevision + 1
	)
		return stale;
	const contents: OsAppDraftContent[] = [];
	for (const revision of history) {
		if (revision.files === null) return stale;
		const snapshot = OsAppDraftContentSchema.safeParse({
			manifest: JSON.parse(revision.manifest),
			files: JSON.parse(revision.files),
		});
		if (!snapshot.success) return stale;
		contents.push(snapshot.data);
	}
	const base = contents[0]!;
	const latest = contents.at(-1)!;
	const changedFiles = (before: OsAppDraftContent, after: OsAppDraftContent) =>
		[
			...new Set([...Object.keys(before.files), ...Object.keys(after.files)]),
		].filter((name) => before.files[name] !== after.files[name]);
	const proposedFiles = changedFiles(base, draft.data);
	const mainlineFiles = new Set<string>();
	let mainlineManifestChanged = false;
	const manifestText = (content: OsAppDraftContent) =>
		normalizeStoredJsonText(JSON.stringify(content.manifest));
	for (let index = 1; index < contents.length; index++) {
		const before = contents[index - 1]!;
		const after = contents[index]!;
		for (const name of changedFiles(before, after)) mainlineFiles.add(name);
		mainlineManifestChanged ||= manifestText(before) !== manifestText(after);
	}
	const proposedManifestChanged =
		manifestText(base) !== manifestText(draft.data);
	if (
		proposedFiles.some((name) => mainlineFiles.has(name)) ||
		(proposedManifestChanged && mainlineManifestChanged)
	)
		return stale;
	const files = { ...latest.files };
	for (const name of proposedFiles) {
		if (Object.hasOwn(draft.data.files, name))
			files[name] = draft.data.files[name]!;
		else delete files[name];
	}
	return {
		baseRevisionId: current.id,
		baseRevision: current.revision,
		content: JSON.stringify({
			manifest: proposedManifestChanged ? draft.data.manifest : latest.manifest,
			files,
		}),
	};
}

async function decideOsCollaborationProposalUnannounced(
	db: DbQueryClient,
	params: OsCollaborationProposalScope & {
		expectedSequence: number;
		decision: "accepted" | "rejected";
		rationale: string;
		evidenceRefs: string;
		decidedByKind: OsCollaborationProposalRow["createdByKind"];
		decidedById: string;
	},
): Promise<OsCollaborationProposalRow | StaleProposalResult | undefined> {
	let acceptance:
		| Pick<
				OsCollaborationProposalRow,
				"content" | "baseRevisionId" | "baseRevision"
		  >
		| undefined;
	let acceptanceFence;
	if (params.decision === "accepted") {
		const proposal = await getOsCollaborationProposal(db, params);
		if (
			!proposal ||
			proposal.status !== "open" ||
			proposal.sequence !== params.expectedSequence
		)
			return undefined;
		if (proposal.documentType === "gadget") {
			const [gadget] = await db
				.select({
					currentRevisionId: osGadgets.currentRevisionId,
					workspaceId: osGadgets.workspaceId,
				})
				.from(osGadgets)
				.where(
					and(
						eq(osGadgets.organizationId, proposal.organizationId),
						eq(osGadgets.id, proposal.documentId),
					),
				)
				.limit(1);
			if (
				!gadget?.currentRevisionId ||
				gadget.workspaceId !== proposal.workspaceId
			)
				return { reason: "stale_base" };
			if (gadget.currentRevisionId !== proposal.baseRevisionId) {
				const rebased = await rebaseStaleAppProposal(
					db,
					proposal,
					gadget.currentRevisionId,
				);
				if ("reason" in rebased) return rebased;
				acceptance = rebased;
			}
			// Mainline and a concurrent rebase must still match the snapshots read above.
			acceptanceFence = and(
				eq(osCollaborationProposals.baseRevisionId, proposal.baseRevisionId),
				eq(osCollaborationProposals.content, proposal.content),
				sql`exists (select 1 from ${osGadgets} where ${osGadgets.id} = ${proposal.documentId}
					and ${osGadgets.organizationId} = ${proposal.organizationId}
					and ${osGadgets.workspaceId} = ${proposal.workspaceId}
					and ${osGadgets.currentRevisionId} = ${gadget.currentRevisionId})`,
			);
		}
	}
	const allowedStatuses =
		params.decision === "accepted"
			? (["open"] as const)
			: (["open", "accepted"] as const);
	const now = new Date().toISOString();
	const [row] = await db
		.update(osCollaborationProposals)
		.set({
			...acceptance,
			status: params.decision,
			decisionRationale: params.rationale,
			decisionEvidenceRefs: params.evidenceRefs,
			decidedByKind: params.decidedByKind,
			decidedById: params.decidedById,
			decidedAt: now,
			updatedAt: now,
		})
		.where(
			and(
				acceptanceFence,
				eq(osCollaborationProposals.organizationId, params.organizationId),
				eq(osCollaborationProposals.id, params.proposalId),
				// bound-params: allowed-transition guard over the closed status enum
				inArray(osCollaborationProposals.status, [...allowedStatuses]),
				eq(osCollaborationProposals.sequence, params.expectedSequence),
			),
		)
		.returning();
	return row ?? (acceptanceFence ? { reason: "stale_base" } : undefined);
}

export async function decideOsCollaborationProposal(
	db: DbQueryClient,
	params: OsCollaborationProposalScope & {
		expectedSequence: number;
		decision: "accepted" | "rejected";
		rationale: string;
		evidenceRefs: string;
		decidedByKind: OsCollaborationProposalRow["createdByKind"];
		decidedById: string;
	},
): Promise<OsCollaborationProposalRow | StaleProposalResult | undefined> {
	const result = await decideOsCollaborationProposalUnannounced(db, params);
	if (result && "workspaceId" in result) {
		await announceOsWorkspaceChange(
			db,
			result.workspaceId,
			result.documentType === "gadget" ? "drafts" : "proposals",
		);
	}
	return result;
}

export type MergeOsCollaborationProposalResult =
	| {
			ok: true;
			proposal: OsCollaborationProposalRow;
			revision: OsGadgetRevisionRow | OsOutputRevisionRow;
	  }
	| { ok: false; reason: "proposal_conflict" | "revision_conflict" };

/**
 * A gadget proposal is either a bare manifest or, for a runtime app, an object
 * with the manifest and its source files. The merge records the manifest on
 * the revision and the files in `os_gadget_code`; the files never land in the
 * manifest column.
 */
export function splitGadgetProposalContent(content: string): {
	manifest: string;
	code: { files: string; codeLength: number } | null;
} {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return { manifest: content, code: null };
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		Array.isArray(parsed) ||
		!("manifest" in parsed) ||
		!("files" in parsed)
	) {
		return { manifest: content, code: null };
	}
	const { manifest, files } = parsed as { manifest: unknown; files: unknown };
	if (
		typeof manifest !== "object" ||
		manifest === null ||
		typeof files !== "object" ||
		files === null ||
		Array.isArray(files)
	) {
		return { manifest: content, code: null };
	}
	const codeLength = Object.values(
		files as Record<string, unknown>,
	).reduce<number>(
		(sum, text) => sum + (typeof text === "string" ? text.length : 0),
		0,
	);
	return {
		manifest: JSON.stringify(manifest),
		code: { files: JSON.stringify(files), codeLength },
	};
}

export interface CommitCollaborationOutputParams {
	proposal: OsCollaborationProposalRow;
	revision: OsOutputRevisionRow;
}

export type CommitCollaborationOutput = (
	params: CommitCollaborationOutputParams,
) => Promise<
	| { ok: true; revision: OsOutputRevisionRow }
	| { ok: false; reason: "revision_conflict" }
>;

async function mergeOsCollaborationProposalUnannounced(
	db: DbQueryClient,
	params: OsCollaborationProposalScope & {
		expectedSequence: number;
		revisionId: string;
		rationale: string;
		evidenceRefs: string;
		mergedByKind: OsCollaborationProposalRow["createdByKind"];
		mergedById: string;
		outputBody?: {
			contentSha256: string;
			contentBytes: number;
			bodyR2Key: string;
			content: string;
		};
	},
	commitOutput?: CommitCollaborationOutput,
): Promise<MergeOsCollaborationProposalResult> {
	const proposal = await getOsCollaborationProposal(db, params);
	if (
		!proposal ||
		(proposal.status !== "accepted" &&
			!(proposal.documentType === "output" && proposal.status === "merged")) ||
		proposal.sequence !== params.expectedSequence
	) {
		return { ok: false, reason: "proposal_conflict" };
	}

	const now = new Date().toISOString();
	const proposalFence = and(
		eq(osCollaborationProposals.id, proposal.id),
		eq(osCollaborationProposals.organizationId, proposal.organizationId),
		eq(osCollaborationProposals.status, "accepted"),
		eq(osCollaborationProposals.sequence, params.expectedSequence),
	);

	if (proposal.documentType === "gadget") {
		const { manifest, code } = splitGadgetProposalContent(proposal.content);
		const insertRevision = db
			.insert(osGadgetRevisions)
			.select(
				db
					.select({
						id: sql<string>`${params.revisionId}`.as("id"),
						organizationId: osCollaborationProposals.organizationId,
						gadgetId: osCollaborationProposals.documentId,
						revision:
							sql<number>`${osCollaborationProposals.baseRevision} + 1`.as(
								"revision",
							),
						manifest: sql<string>`${manifest}`.as("manifest"),
						sourceArtifactRef: sql<string | null>`null`.as(
							"source_artifact_ref",
						),
						createdByKind: sql<
							OsGadgetRevisionRow["createdByKind"]
						>`${params.mergedByKind}`.as("created_by_kind"),
						createdById: sql<string>`${params.mergedById}`.as("created_by_id"),
						createdAt: sql<string>`${now}`.as("created_at"),
					})
					.from(osCollaborationProposals)
					.innerJoin(
						osGadgets,
						and(
							eq(osGadgets.id, osCollaborationProposals.documentId),
							eq(
								osGadgets.organizationId,
								osCollaborationProposals.organizationId,
							),
							eq(osGadgets.workspaceId, osCollaborationProposals.workspaceId),
							eq(
								osGadgets.currentRevisionId,
								osCollaborationProposals.baseRevisionId,
							),
						),
					)
					.where(proposalFence),
			)
			.returning();
		const advancePointer = db
			.update(osGadgets)
			.set({ currentRevisionId: params.revisionId, updatedAt: now })
			.where(
				and(
					eq(osGadgets.id, proposal.documentId),
					eq(osGadgets.organizationId, params.organizationId),
					eq(osGadgets.currentRevisionId, proposal.baseRevisionId),
					sql`changes() = 1`,
				),
			);
		const settle = db
			.update(osCollaborationProposals)
			.set({
				status: "merged",
				mergeRationale: params.rationale,
				mergeEvidenceRefs: params.evidenceRefs,
				mergedByKind: params.mergedByKind,
				mergedById: params.mergedById,
				mergedAt: now,
				resultRevisionId: params.revisionId,
				resultRevision: proposal.baseRevision + 1,
				updatedAt: now,
			})
			.where(and(proposalFence, sql`changes() = 1`))
			.returning();
		// The code statements select from the revision just written, so they land
		// only when the fenced revision insert did: one batch, no half-recorded app.
		const codeStatements = code
			? buildOsGadgetRevisionCodeStatements(db, {
					...code,
					revisionId: params.revisionId,
					sha256: await osGadgetCodeSha256(code.files),
					createdAt: now,
				})
			: null;
		const [revisionRows, , proposalRows] = codeStatements
			? await db.batch([
					insertRevision,
					advancePointer,
					settle,
					...codeStatements,
				])
			: await db.batch([insertRevision, advancePointer, settle]);
		const revision = revisionRows[0];
		const mergedProposal = proposalRows[0];
		return revision && mergedProposal
			? { ok: true, proposal: mergedProposal, revision }
			: { ok: false, reason: "revision_conflict" };
	}
	const [baseRevision] = await db
		.select({ accessEnvelope: workspaceOutputIndex.accessEnvelope })
		.from(workspaceOutputIndex)
		.where(
			and(
				eq(workspaceOutputIndex.revisionId, proposal.baseRevisionId),
				eq(workspaceOutputIndex.organizationId, params.organizationId),
				eq(workspaceOutputIndex.workspaceId, proposal.workspaceId),
				eq(workspaceOutputIndex.outputId, proposal.documentId),
				eq(workspaceOutputIndex.revision, proposal.baseRevision),
			),
		)
		.limit(1);
	if (!baseRevision) return { ok: false, reason: "revision_conflict" };
	let producerEnvelope: string | null = null;
	const hasAttestedRun =
		proposal.sourceAttestationVersion === 1 && proposal.sourceKind === "run";
	if (hasAttestedRun) {
		const executions = await db
			.select({ accessEnvelope: osGadgetExecutions.resourceAccessEnvelope })
			.from(osGadgetExecutions)
			.where(
				and(
					eq(osGadgetExecutions.organizationId, params.organizationId),
					eq(osGadgetExecutions.runId, proposal.sourceId),
				),
			)
			.limit(2);
		// run_id is not unique in the current schema. Never choose an arbitrary
		// producer when multiple same-org receipts claim it; ambiguity is
		// unverifiable lineage and therefore fails closed.
		producerEnvelope =
			executions.length === 1 ? (executions[0]?.accessEnvelope ?? null) : null;
	}
	const accessEnvelope = hasAttestedRun
		? mergeOsOutputAccessEnvelopes(
				baseRevision.accessEnvelope,
				producerEnvelope,
			)
		: mergeOsOutputAccessEnvelopes(baseRevision.accessEnvelope, null);

	if (!commitOutput)
		throw new Error(
			"Collaboration output merges require an activated workspace object",
		);
	if (params.outputBody && params.outputBody.content !== proposal.content)
		return { ok: false, reason: "proposal_conflict" };
	// The proposal UUID is also the output revision UUID. Unlike the caller's
	// fresh request UUID, it survives a crash before the shared receipt.
	const committed = await commitOutput({
		proposal,
		revision: {
			id: proposal.id,
			organizationId: proposal.organizationId,
			outputId: proposal.documentId,
			revision: proposal.baseRevision + 1,
			content: "",
			note: params.rationale,
			createdByKind: params.mergedByKind,
			createdById: params.mergedById,
			createdAt: now,
			skillRunId: hasAttestedRun ? proposal.sourceId : null,
			skillId: null,
			agentTurnId: null,
			accessEnvelope,
			contentSha256: params.outputBody?.contentSha256 ?? null,
			contentBytes: params.outputBody?.contentBytes ?? null,
			bodyR2Key: params.outputBody?.bodyR2Key ?? null,
		},
	});
	if (!committed.ok) return committed;
	const revision = committed.revision;
	if (proposal.status === "merged")
		return proposal.resultRevisionId === revision.id
			? { ok: true, proposal, revision }
			: { ok: false, reason: "proposal_conflict" };
	const [mergedProposal] = await db
		.update(osCollaborationProposals)
		.set({
			status: "merged",
			mergeRationale: revision.note,
			mergeEvidenceRefs: params.evidenceRefs,
			mergedByKind: revision.createdByKind,
			mergedById: revision.createdById,
			mergedAt: revision.createdAt,
			resultRevisionId: revision.id,
			resultRevision: revision.revision,
			updatedAt: now,
		})
		.where(proposalFence)
		.returning();
	if (mergedProposal) return { ok: true, proposal: mergedProposal, revision };
	const receipt = await getOsCollaborationProposal(db, params);
	return receipt?.status === "merged" &&
		receipt.sequence === params.expectedSequence &&
		receipt.resultRevisionId === revision.id
		? { ok: true, proposal: receipt, revision }
		: { ok: false, reason: "proposal_conflict" };
}

export async function mergeOsCollaborationProposal(
	db: DbQueryClient,
	params: OsCollaborationProposalScope & {
		expectedSequence: number;
		revisionId: string;
		rationale: string;
		evidenceRefs: string;
		mergedByKind: OsCollaborationProposalRow["createdByKind"];
		mergedById: string;
		outputBody?: {
			contentSha256: string;
			contentBytes: number;
			bodyR2Key: string;
			content: string;
		};
	},
	commitOutput?: CommitCollaborationOutput,
): Promise<MergeOsCollaborationProposalResult> {
	const result = await mergeOsCollaborationProposalUnannounced(
		db,
		params,
		commitOutput,
	);
	if (result.ok) {
		await announceOsWorkspaceChange(
			db,
			result.proposal.workspaceId,
			result.proposal.documentType === "gadget" ? "drafts" : "proposals",
		);
	}
	return result;
}

export interface AppEditSource {
	organizationId: string;
	workspaceId: string;
	gadgetId: string;
	sourceKind: OsCollaborationProposalRow["sourceKind"];
	sourceId: string;
}

export async function getOsAppEditDraft(
	db: DbQueryClient,
	scope: AppEditSource,
) {
	const rows = await listOsCollaborationProposals(db, scope.organizationId, {
		workspaceId: scope.workspaceId,
		documentType: "gadget",
		documentId: scope.gadgetId,
		sourceKind: scope.sourceKind,
		sourceId: scope.sourceId,
		statuses: ["open", "accepted"],
		limit: 2,
	});
	if (rows.length > 1)
		throw new Error(
			"Multiple pending app drafts; review them before editing again",
		);
	const row = rows[0];
	if (row && row.sourceAttestationVersion !== 1)
		throw new Error("App draft source is not attested");
	return row;
}

/** Both app editors accumulate files in a proposal; only the decision path saves code. */
export async function proposeOsAppFileEdits(
	db: DbQueryClient,
	input: AppEditSource & {
		proposalId?: string;
		expectedSequence?: number;
		baseRevisionId: string;
		baseRevision: number;
		content: OsAppDraftContent;
		edits: Array<{ path: string; before?: string; after: string }>;
		createdByKind: OsCollaborationProposalRow["createdByKind"];
		createdById: string;
	},
	validate: (content: OsAppDraftContent) => Promise<void>,
) {
	const pending = await getOsAppEditDraft(db, input);
	if (
		pending &&
		(pending.status !== "open" ||
			pending.baseRevisionId !== input.baseRevisionId ||
			pending.id !== input.proposalId ||
			pending.sequence !== input.expectedSequence)
	)
		throw new Error("App draft changed; read it again before editing");
	if (
		!pending &&
		(input.proposalId !== undefined || input.expectedSequence !== undefined)
	)
		throw new Error("App draft changed; read it again before editing");
	const content = pending
		? OsAppDraftContentSchema.parse(JSON.parse(pending.content))
		: input.content;
	const files = { ...content.files };
	for (const edit of input.edits) {
		if (edit.before !== undefined) {
			const text = Object.hasOwn(files, edit.path)
				? files[edit.path]
				: undefined;
			if (
				!edit.before ||
				text === undefined ||
				text.split(edit.before).length !== 2
			)
				throw new Error("App edit must match exactly once in the current file");
			files[edit.path] = text.replace(edit.before, () => edit.after);
		} else files[edit.path] = edit.after;
	}
	const updated = OsAppDraftContentSchema.parse({ ...content, files });
	await validate(updated);
	if (pending) {
		const row = await updateOsCollaborationProposalPreview(db, {
			organizationId: input.organizationId,
			proposalId: pending.id,
			expectedSequence: pending.sequence,
			sourceKind: input.sourceKind,
			sourceId: input.sourceId,
			content: JSON.stringify(updated),
		});
		if (!row)
			throw new Error("App draft changed; read it again before editing");
		return row;
	}
	// Competing first edits use the same id, so one must re-read instead of creating two drafts.
	const [previous] = await listOsCollaborationProposals(
		db,
		input.organizationId,
		{
			workspaceId: input.workspaceId,
			documentType: "gadget",
			documentId: input.gadgetId,
			sourceKind: input.sourceKind,
			sourceId: input.sourceId,
			limit: 1,
		},
	);
	if (previous && ["open", "accepted"].includes(previous.status))
		throw new Error("App draft changed; read it again before editing");
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(
			JSON.stringify([
				input.organizationId,
				input.workspaceId,
				input.gadgetId,
				input.sourceKind,
				input.sourceId,
				previous?.id ?? null,
			]),
		),
	);
	const hex = Array.from(new Uint8Array(digest), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");
	const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
	const [created] = await db
		.insert(osCollaborationProposals)
		.values({
			id,
			organizationId: input.organizationId,
			workspaceId: input.workspaceId,
			documentType: "gadget",
			documentId: input.gadgetId,
			baseRevisionId: input.baseRevisionId,
			baseRevision: input.baseRevision,
			status: "open",
			sourceKind: input.sourceKind,
			sourceId: input.sourceId,
			sourceAttestationVersion: 1,
			content: JSON.stringify(updated),
			sequence: 0,
			createdByKind: input.createdByKind,
			createdById: input.createdById,
		})
		.onConflictDoNothing()
		.returning();
	if (!created)
		throw new Error("App draft changed; read it again before editing");
	return created;
}
