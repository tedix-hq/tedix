import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { createMigratedSqlite } from "../../test/migrated-sqlite";
import { workItems } from "../../schema/work-items";
import { workApprovalProposals } from "../../schema/work-factory";
import { organizationMembers } from "../../schema/organization-members";
import {
	ensureWorkRiskApproval,
	decideWorkApproval,
	listWorkApprovalInbox,
} from "./approvals";

const now = "2026-10-20T12:00:00.000Z";
describe("automatic risk approvals", () => {
	it.each([
		["approved", "high"],
		["rejected", "critical"],
	] as const)(
		"creates one visible request and records %s",
		async (decision, riskLevel) => {
			const db = createDbQueryClient(
				createD1Facade(createMigratedSqlite({ foreignKeys: false })),
			);
			await db.insert(organizationMembers).values({
				id: "member",
				organizationId: "org",
				userId: "owner",
				descopeUserId: "owner",
				email: "owner@example.test",
				role: "owner",
				status: "active",
				createdAt: now,
				updatedAt: now,
			});
			const expectedApprover = riskLevel === "high" ? "accountable" : "owner";
			if (riskLevel === "high")
				await db.insert(organizationMembers).values({
					id: "accountable-member",
					organizationId: "org",
					userId: "accountable",
					descopeUserId: "accountable",
					email: "accountable@example.test",
					role: "member",
					status: "active",
					createdAt: now,
					updatedAt: now,
				});
			const [item] = await db
				.insert(workItems)
				.values({
					id: "work",
					orgId: "org",
					title: "Review risky change",
					disposition: "accepted",
					riskLevel,
					admissionSpecRevision: "test-risk-revision",
					accountableOwnerType: riskLevel === "high" ? "user" : null,
					accountableOwnerId: riskLevel === "high" ? "accountable" : null,
					createdAt: now,
					updatedAt: now,
				})
				.returning();
			await Promise.all([
				ensureWorkRiskApproval(db, item!, now),
				ensureWorkRiskApproval(db, item!, now),
			]);
			const inbox = await listWorkApprovalInbox(db, {
				orgId: "org",
				statuses: ["pending"],
				observedAt: now,
			});
			expect(inbox.data).toHaveLength(1);
			const proposal = inbox.data[0]!.proposal;
			expect(proposal.approverId).toBe(expectedApprover);
			expect(proposal.rationale).toContain(`risk is ${riskLevel}`);
			expect(inbox.data[0]!.workItem.id).toBe(item!.id);
			const recorded = await decideWorkApproval(db, {
				id: "decision",
				orgId: "org",
				proposalId: proposal.id,
				expectedVersion: proposal.version,
				decision,
				deciderType: "user",
				deciderId: expectedApprover,
				rationale: "Reviewed",
				now,
			});
			expect(recorded.decision).toBe(decision);
			await ensureWorkRiskApproval(db, item!, now);
			expect(await db.select().from(workApprovalProposals)).toHaveLength(1);
		},
	);
});
