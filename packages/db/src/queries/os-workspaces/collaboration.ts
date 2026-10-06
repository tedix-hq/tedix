import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import {
	type NewOsCollaborationProposalRow,
	type OsCollaborationProposalRow,
	type OsGadgetRevisionRow,
	type OsOutputRevisionRow,
	osCollaborationProposals,
	osGadgetRevisions,
	osGadgetExecutions,
	osGadgets,
	osOutputRevisions,
	osOutputs,
} from "../../schema/os-workspaces";
import { mergeOsOutputAccessEnvelopes } from "../../utils/os-output-access-envelope";

export interface OsCollaborationProposalScope {
	organizationId: string;
	proposalId: string;
}

export interface ListOsCollaborationProposalsOptions {
	workspaceId?: string;
	documentType?: OsCollaborationProposalRow["documentType"];
	documentId?: string;
	statuses?: OsCollaborationProposalRow["status"][];
	limit?: number;
}

export async function createOsCollaborationProposal(
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

export async function updateOsCollaborationProposalPreview(
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
): Promise<OsCollaborationProposalRow | undefined> {
	const allowedStatuses =
		params.decision === "accepted"
			? (["open"] as const)
			: (["open", "accepted"] as const);
	const now = new Date().toISOString();
	const [row] = await db
		.update(osCollaborationProposals)
		.set({
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
				eq(osCollaborationProposals.organizationId, params.organizationId),
				eq(osCollaborationProposals.id, params.proposalId),
				// bound-params: allowed-transition guard over the closed status enum
				inArray(osCollaborationProposals.status, [...allowedStatuses]),
				eq(osCollaborationProposals.sequence, params.expectedSequence),
			),
		)
		.returning();
	return row;
}

export type MergeOsCollaborationProposalResult =
	| {
			ok: true;
			proposal: OsCollaborationProposalRow;
			revision: OsGadgetRevisionRow | OsOutputRevisionRow;
	  }
	| { ok: false; reason: "proposal_conflict" | "revision_conflict" };

/**
 * Merge an accepted proposal into the canonical gadget/output revision chain.
 * The revision insert, current pointer advance, and proposal settlement are a
 * single D1 batch. Every statement is prebuilt and fenced by the previous
 * statement's `changes()`, so no accepted preview can silently become only
 * partially canonical.
 */
export async function mergeOsCollaborationProposal(
	db: DbQueryClient,
	params: OsCollaborationProposalScope & {
		expectedSequence: number;
		revisionId: string;
		rationale: string;
		evidenceRefs: string;
		mergedByKind: OsCollaborationProposalRow["createdByKind"];
		mergedById: string;
	},
): Promise<MergeOsCollaborationProposalResult> {
	const proposal = await getOsCollaborationProposal(db, params);
	if (
		!proposal ||
		proposal.status !== "accepted" ||
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
						manifest: osCollaborationProposals.content,
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
		const [revisionRows, , proposalRows] = await db.batch([
			insertRevision,
			advancePointer,
			settle,
		]);
		const revision = revisionRows[0];
		const mergedProposal = proposalRows[0];
		return revision && mergedProposal
			? { ok: true, proposal: mergedProposal, revision }
			: { ok: false, reason: "revision_conflict" };
	}
	const [baseRevision] = await db
		.select({ accessEnvelope: osOutputRevisions.accessEnvelope })
		.from(osOutputRevisions)
		.where(
			and(
				eq(osOutputRevisions.id, proposal.baseRevisionId),
				eq(osOutputRevisions.organizationId, params.organizationId),
				eq(osOutputRevisions.outputId, proposal.documentId),
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

	const insertRevision = db
		.insert(osOutputRevisions)
		.select(
			db
				.select({
					id: sql<string>`${params.revisionId}`.as("id"),
					organizationId: osCollaborationProposals.organizationId,
					outputId: osCollaborationProposals.documentId,
					revision:
						sql<number>`${osCollaborationProposals.baseRevision} + 1`.as(
							"revision",
						),
					content: osCollaborationProposals.content,
					note: sql<string>`${params.rationale}`.as("note"),
					createdByKind: sql<
						OsOutputRevisionRow["createdByKind"]
					>`${params.mergedByKind}`.as("created_by_kind"),
					createdById: sql<string>`${params.mergedById}`.as("created_by_id"),
					createdAt: sql<string>`${now}`.as("created_at"),
					// The producer is the run that authored the proposed bytes, not the
					// operator who merged them — the merger is already created_by. The
					// proposal persists that source itself, so it is projected from the
					// joined row rather than re-derived from a request header the
					// merging operator would not carry. Kept last: positional bind.
					skillRunId: sql<
						string | null
					>`case when ${osCollaborationProposals.sourceAttestationVersion} = 1 and ${osCollaborationProposals.sourceKind} = 'run' then ${osCollaborationProposals.sourceId} else null end`.as(
						"skill_run_id",
					),
					skillId: sql<string | null>`null`.as("skill_id"),
					accessEnvelope: sql<string | null>`${accessEnvelope}`.as(
						"access_envelope",
					),
				})
				.from(osCollaborationProposals)
				.innerJoin(
					osOutputs,
					and(
						eq(osOutputs.id, osCollaborationProposals.documentId),
						eq(
							osOutputs.organizationId,
							osCollaborationProposals.organizationId,
						),
						eq(osOutputs.workspaceId, osCollaborationProposals.workspaceId),
						eq(
							osOutputs.currentRevisionId,
							osCollaborationProposals.baseRevisionId,
						),
					),
				)
				.where(proposalFence),
		)
		.returning();
	const advancePointer = db
		.update(osOutputs)
		.set({ currentRevisionId: params.revisionId, updatedAt: now })
		.where(
			and(
				eq(osOutputs.id, proposal.documentId),
				eq(osOutputs.organizationId, params.organizationId),
				eq(osOutputs.currentRevisionId, proposal.baseRevisionId),
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
	const [revisionRows, , proposalRows] = await db.batch([
		insertRevision,
		advancePointer,
		settle,
	]);
	const revision = revisionRows[0];
	const mergedProposal = proposalRows[0];
	return revision && mergedProposal
		? { ok: true, proposal: mergedProposal, revision }
		: { ok: false, reason: "revision_conflict" };
}
