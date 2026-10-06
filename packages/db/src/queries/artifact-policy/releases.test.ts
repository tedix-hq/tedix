import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import {
	artifactRedactionCandidates,
	artifactReleaseReviews,
} from "../../schema/artifact-releases";
import { tediArtifacts } from "../../schema/cognitive-runtime";
import {
	policyPacks,
	runtimeProfiles,
	workspaceTemplateSets,
} from "../../schema/control-plane";
import { organizationMembers } from "../../schema/organization-members";
import { organizations } from "../../schema/organizations";
import { tedis } from "../../schema/tedis";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import {
	appendArtifactReleaseReview,
	ArtifactReleaseConflictError,
	createArtifactRedactionCandidate,
	getActiveArtifactReleaseApproval,
	getArtifactReleaseReviewHead,
} from "./releases";

const PARENT_DIGEST = "a".repeat(64);
const CHILD_DIGEST = "b".repeat(64);

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON");
	sqlite.exec(
		schemaDdl(
			organizations,
			runtimeProfiles,
			policyPacks,
			workspaceTemplateSets,
			tedis,
			organizationMembers,
			tediArtifacts,
			artifactRedactionCandidates,
			artifactReleaseReviews,
		),
	);
	sqlite.exec(`
		INSERT INTO organizations (id, name, slug) VALUES ('org-1','One','one'), ('org-2','Two','two');
		INSERT INTO tedis (id, organization_id, name, slug) VALUES ('tedi-1','org-1','One','one'), ('tedi-2','org-2','Two','two');
		INSERT INTO organization_members (id, organization_id, user_id, descope_user_id, email, role, status)
		VALUES ('member-1','org-1','user-1','descope-1','owner@example.com','owner','active');
	`);
	return { sqlite, db: createDbQueryClient(createD1Facade(sqlite)) };
}

async function seedArtifacts(
	db: ReturnType<typeof fixture>["db"],
	input: {
		parentClassification?: "runtime_private" | "explicit_shareable";
		childOrganizationId?: string;
		childTediId?: string;
	} = {},
) {
	await db.insert(tediArtifacts).values([
		{
			id: "parent-1",
			organizationId: "org-1",
			tediId: "tedi-1",
			kind: "file",
			name: "original.txt",
			contentDigest: PARENT_DIGEST,
			accessClassification: input.parentClassification ?? "runtime_private",
			publicationState: "ready",
		},
		{
			id: "child-1",
			organizationId: input.childOrganizationId ?? "org-1",
			tediId: input.childTediId ?? "tedi-1",
			kind: "file",
			name: "redacted.txt",
			contentDigest: CHILD_DIGEST,
			accessClassification: "runtime_private",
			publicationState: "ready",
		},
	]);
}

const candidate = {
	id: "candidate-1",
	organizationId: "org-1",
	tediId: "tedi-1",
	parentArtifactId: "parent-1",
	parentContentDigest: PARENT_DIGEST,
	childArtifactId: "child-1",
	childContentDigest: CHILD_DIGEST,
	idempotencyKey: "redact-once",
	createdByMemberId: "member-1",
	createdByUserId: "user-1",
	createdAt: "2026-09-23T10:00:00.000Z",
};

function review(input: {
	id: string;
	previousReviewId: string;
	eventType: "approved" | "revoked";
}) {
	return {
		id: input.id,
		organizationId: "org-1",
		tediId: "tedi-1",
		candidateId: candidate.id,
		eventType: input.eventType,
		previousReviewId: input.previousReviewId,
		targetApprovalId:
			input.eventType === "revoked" ? input.previousReviewId : null,
		childContentDigest: CHILD_DIGEST,
		reviewerMemberId: "member-1",
		reviewerUserId: "user-1",
		reviewerDescopeUserId: "descope-1",
		attestation: `${input.eventType} exact reviewed bytes`,
		createdAt: "2026-09-23T10:00:00.000Z",
	};
}

describe("artifact release persistence", () => {
	it("atomically claims the exact private parent/child tuple and replays only exactly", async () => {
		const { db } = fixture();
		await seedArtifacts(db);
		expect(
			(await createArtifactRedactionCandidate(db, candidate)).created,
		).toBe(true);
		expect(
			(await createArtifactRedactionCandidate(db, candidate)).created,
		).toBe(false);
		await expect(
			createArtifactRedactionCandidate(db, {
				...candidate,
				childContentDigest: "c".repeat(64),
			}),
		).rejects.toBeInstanceOf(ArtifactReleaseConflictError);
	});

	it("rejects public parents and cross-tenant child tuples", async () => {
		const publicFixture = fixture();
		await seedArtifacts(publicFixture.db, {
			parentClassification: "explicit_shareable",
		});
		await expect(
			createArtifactRedactionCandidate(publicFixture.db, candidate),
		).rejects.toBeInstanceOf(ArtifactReleaseConflictError);

		const crossTenant = fixture();
		await seedArtifacts(crossTenant.db, {
			childOrganizationId: "org-2",
			childTediId: "tedi-2",
		});
		await expect(
			createArtifactRedactionCandidate(crossTenant.db, candidate),
		).rejects.toBeInstanceOf(ArtifactReleaseConflictError);
	});

	it("preserves candidate and review audit rows by refusing artifact deletion", async () => {
		const { sqlite, db } = fixture();
		await seedArtifacts(db);
		await createArtifactRedactionCandidate(db, candidate);
		await appendArtifactReleaseReview(
			db,
			review({
				id: "approval-1",
				previousReviewId: candidate.id,
				eventType: "approved",
			}),
		);
		expect(() =>
			sqlite.exec("DELETE FROM tedi_artifacts WHERE id = 'child-1'"),
		).toThrow();
		expect(() =>
			sqlite.exec("DELETE FROM tedi_artifacts WHERE id = 'parent-1'"),
		).toThrow();
		expect(() =>
			sqlite.exec(
				"DELETE FROM artifact_redaction_candidates WHERE id = 'candidate-1'",
			),
		).toThrow();
		expect(() =>
			sqlite.exec("DELETE FROM tedis WHERE id = 'tedi-1'"),
		).toThrow();
		expect(await db.select().from(artifactRedactionCandidates)).toHaveLength(1);
		expect(await db.select().from(artifactReleaseReviews)).toHaveLength(1);
		sqlite.exec("DELETE FROM organization_members WHERE id = 'member-1'");
		expect(await db.select().from(artifactReleaseReviews)).toHaveLength(1);
		expect(
			await getActiveArtifactReleaseApproval(db, {
				organizationId: "org-1",
				childArtifactId: "child-1",
				approvalId: "approval-1",
				childContentDigest: CHILD_DIGEST,
			}),
		).toBeNull();
	});

	it("enforces a linear alternating CAS chain and exact retry", async () => {
		const { db } = fixture();
		await seedArtifacts(db);
		await createArtifactRedactionCandidate(db, candidate);
		const approval = review({
			id: "approval-1",
			previousReviewId: candidate.id,
			eventType: "approved",
		});
		expect((await appendArtifactReleaseReview(db, approval)).created).toBe(
			true,
		);
		expect((await appendArtifactReleaseReview(db, approval)).created).toBe(
			false,
		);
		await expect(
			appendArtifactReleaseReview(
				db,
				review({
					id: "forked-approval",
					previousReviewId: candidate.id,
					eventType: "approved",
				}),
			),
		).rejects.toBeInstanceOf(ArtifactReleaseConflictError);
		const revoked = review({
			id: "revocation-1",
			previousReviewId: approval.id,
			eventType: "revoked",
		});
		await appendArtifactReleaseReview(db, revoked);
		await expect(
			appendArtifactReleaseReview(
				db,
				review({
					id: "double-revoke",
					previousReviewId: revoked.id,
					eventType: "revoked",
				}),
			),
		).rejects.toBeInstanceOf(ArtifactReleaseConflictError);
		expect(
			(
				await getArtifactReleaseReviewHead(db, {
					organizationId: "org-1",
					candidateId: candidate.id,
				})
			)?.id,
		).toBe(revoked.id);
	});

	it("resolves a chain longer than 200 by graph head, not timestamp order", async () => {
		const { db } = fixture();
		await seedArtifacts(db);
		await createArtifactRedactionCandidate(db, candidate);
		let previous = candidate.id;
		for (let index = 0; index < 201; index++) {
			const eventType = index % 2 === 0 ? "approved" : "revoked";
			const id = `review-${String(index).padStart(3, "0")}`;
			await appendArtifactReleaseReview(
				db,
				review({ id, previousReviewId: previous, eventType }),
			);
			previous = id;
		}
		expect(
			(
				await getArtifactReleaseReviewHead(db, {
					organizationId: "org-1",
					candidateId: candidate.id,
				})
			)?.id,
		).toBe("review-200");
	});

	it("requires current active canonical owner identity at append and public read", async () => {
		const { sqlite, db } = fixture();
		await seedArtifacts(db);
		await createArtifactRedactionCandidate(db, candidate);
		sqlite.exec(
			"UPDATE organization_members SET status = 'deactivated' WHERE id = 'member-1'",
		);
		await expect(
			appendArtifactReleaseReview(
				db,
				review({
					id: "approval-after-demotion",
					previousReviewId: candidate.id,
					eventType: "approved",
				}),
			),
		).rejects.toBeInstanceOf(ArtifactReleaseConflictError);

		sqlite.exec(
			"UPDATE organization_members SET status = 'active' WHERE id = 'member-1'",
		);
		const approval = review({
			id: "approval-1",
			previousReviewId: candidate.id,
			eventType: "approved",
		});
		await appendArtifactReleaseReview(db, approval);
		expect(
			await getActiveArtifactReleaseApproval(db, {
				organizationId: "org-1",
				childArtifactId: "child-1",
				approvalId: approval.id,
				childContentDigest: CHILD_DIGEST,
			}),
		).not.toBeNull();
		sqlite.exec(
			"UPDATE organization_members SET role = 'member' WHERE id = 'member-1'",
		);
		expect(
			await getActiveArtifactReleaseApproval(db, {
				organizationId: "org-1",
				childArtifactId: "child-1",
				approvalId: approval.id,
				childContentDigest: CHILD_DIGEST,
			}),
		).toBeNull();
	});
});
