import { DatabaseSync } from "node:sqlite";
import fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";
import { eq } from "drizzle-orm";
import { createDbQueryClient } from "../../query-client";
import {
	osCollaborationProposals,
	osOutputs,
	osOutputRevisions,
} from "../../schema/os-workspaces";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import {
	createOsCollaborationProposal,
	decideOsCollaborationProposal,
	getOsCollaborationProposal,
	mergeOsCollaborationProposal,
	updateOsCollaborationProposalPreview,
} from "./collaboration";

const actions = [
	"edit",
	"staleEdit",
	"approve",
	"staleApprove",
	"reject",
	"merge",
	"staleMerge",
	"competingWrite",
] as const;
type Action = (typeof actions)[number];
const stamp = "2026-01-01T00:00:00.000Z";

async function runSequence(sequence: Action[]) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		schemaDdl(osCollaborationProposals, osOutputs, osOutputRevisions),
	);
	const db = createDbQueryClient(createD1Facade(sqlite));
	const author = {
		createdByKind: "user" as const,
		createdById: "reviewer",
		createdAt: stamp,
	};
	const scope = { organizationId: "org-example", proposalId: "proposal" };
	const model: {
		status: "open" | "accepted" | "rejected" | "merged";
		sequence: number;
		content: string;
		pointer: string;
		revisions: number;
	} = {
		status: "open",
		sequence: 0,
		content: "draft",
		pointer: "base",
		revisions: 1,
	};
	try {
		await db.insert(osOutputs).values({
			id: "file",
			organizationId: scope.organizationId,
			workspaceId: "workspace",
			kind: "document",
			title: "Draft",
			currentRevisionId: "base",
			updatedAt: stamp,
			...author,
		});
		await db.insert(osOutputRevisions).values({
			id: "base",
			organizationId: scope.organizationId,
			outputId: "file",
			revision: 1,
			content: "original",
			...author,
		});
		await createOsCollaborationProposal(db, {
			id: scope.proposalId,
			organizationId: scope.organizationId,
			workspaceId: "workspace",
			documentType: "output",
			documentId: "file",
			baseRevisionId: "base",
			baseRevision: 1,
			status: "open",
			sequence: 0,
			content: model.content,
			sourceKind: "agent_session",
			sourceId: "example-session",
			sourceAttestationVersion: 1,
			updatedAt: stamp,
			...author,
		});
		for (const [index, action] of sequence.entries()) {
			const stale = action.startsWith("stale");
			const expectedSequence = model.sequence - (stale ? 1 : 0);
			if (action === "edit" || action === "staleEdit") {
				const content = `draft-${index}`;
				const allowed = model.status === "open" && !stale;
				const result = await updateOsCollaborationProposalPreview(db, {
					...scope,
					expectedSequence,
					content,
					sourceKind: "agent_session",
					sourceId: "example-session",
				});
				expect(Boolean(result)).toBe(allowed);
				if (allowed) {
					model.sequence++;
					model.content = content;
				}
			} else if (
				action === "approve" ||
				action === "staleApprove" ||
				action === "reject"
			) {
				const decision = action === "reject" ? "rejected" : "accepted";
				const allowed =
					!stale &&
					(model.status === "open" ||
						(decision === "rejected" && model.status === "accepted"));
				const result = await decideOsCollaborationProposal(db, {
					...scope,
					expectedSequence,
					decision,
					rationale: "Reviewed preview",
					evidenceRefs: "[]",
					decidedByKind: "user",
					decidedById: "reviewer",
				});
				expect(Boolean(result)).toBe(allowed);
				if (allowed) model.status = decision;
			} else if (action === "merge" || action === "staleMerge") {
				const allowed =
					model.status === "accepted" && !stale && model.pointer === "base";
				const revisionId = `merged-${index}`;
				const result = await mergeOsCollaborationProposal(db, {
					...scope,
					expectedSequence,
					revisionId,
					rationale: "Approved write",
					evidenceRefs: "[]",
					mergedByKind: "user",
					mergedById: "reviewer",
				});
				expect(result.ok).toBe(allowed);
				if (allowed) {
					model.status = "merged";
					model.pointer = revisionId;
					model.revisions++;
				}
			} else {
				const revisionId = `human-${index}`;
				await db.insert(osOutputRevisions).values({
					id: revisionId,
					organizationId: scope.organizationId,
					outputId: "file",
					revision: model.revisions + 1,
					content: "human edit",
					...author,
				});
				await db
					.update(osOutputs)
					.set({ currentRevisionId: revisionId })
					.where(eq(osOutputs.id, "file"));
				model.pointer = revisionId;
				model.revisions++;
			}
			expect(await getOsCollaborationProposal(db, scope)).toMatchObject({
				status: model.status,
				sequence: model.sequence,
				content: model.content,
			});
			expect((await db.select().from(osOutputs))[0]?.currentRevisionId).toBe(
				model.pointer,
			);
			expect(await db.select().from(osOutputRevisions)).toHaveLength(
				model.revisions,
			);
		}
	} finally {
		sqlite.close();
	}
}

describe("approval and write proposal sequences", () => {
	it("never merges an unapproved/stale preview or overwrites a later human write", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.constantFrom(...actions), { minLength: 1, maxLength: 30 }),
				runSequence,
			),
			{
				seed: 20261113,
				numRuns: 100,
				examples: [
					[
						[
							"merge",
							"edit",
							"staleApprove",
							"approve",
							"staleMerge",
							"merge",
							"merge",
							"reject",
						],
					],
					[["approve", "competingWrite", "merge"]],
					[["approve", "reject", "merge", "approve"]],
				],
			},
		);
	});
});
