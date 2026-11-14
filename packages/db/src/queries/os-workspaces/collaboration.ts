import {
	OsAppDraftContentSchema,
	type OsAppDraftContent,
} from "@tedix/api-contract/schemas/os-workspaces";
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

export async function rebaseOsAppDraft(
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
					// With an R2 body the row keeps the empty-string sentinel that
					// hydrateOutputRevision reads as "fetch the pointer".
					content: params.outputBody
						? sql<string>`''`.as("content")
						: osCollaborationProposals.content,
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
					// merging operator would not carry.
					skillRunId: sql<
						string | null
					>`case when ${osCollaborationProposals.sourceAttestationVersion} = 1 and ${osCollaborationProposals.sourceKind} = 'run' then ${osCollaborationProposals.sourceId} else null end`.as(
						"skill_run_id",
					),
					skillId: sql<string | null>`null`.as("skill_id"),
					accessEnvelope: sql<string | null>`${accessEnvelope}`.as(
						"access_envelope",
					),
					contentSha256: sql<
						string | null
					>`${params.outputBody?.contentSha256 ?? null}`.as("content_sha256"),
					contentBytes: sql<
						number | null
					>`${params.outputBody?.contentBytes ?? null}`.as("content_bytes"),
					bodyR2Key: sql<
						string | null
					>`${params.outputBody?.bodyR2Key ?? null}`.as("body_r2_key"),
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
				.where(
					and(
						proposalFence,
						params.outputBody
							? eq(osCollaborationProposals.content, params.outputBody.content)
							: undefined,
					),
				),
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
