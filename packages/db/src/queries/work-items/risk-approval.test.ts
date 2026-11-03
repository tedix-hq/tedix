import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { createMigratedSqlite } from "../../test/migrated-sqlite";
import { workItems } from "../../schema/work-items";
import { workApprovalProposals } from "../../schema/work-factory";
import { organizationMembers } from "../../schema/organization-members";
import { tedis } from "../../schema/tedis";
import { policyPacks } from "../../schema/control-plane";
import { deriveWorkItemReadiness } from "./readiness";
import { evaluateAndRecordWorkAdmission } from "./admissions";
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

describe("risk approvals for a designated approval tedi", () => {
	const approverTedi = "approval-tedi";
	async function setup(
		input: {
			designate?: boolean;
			tediStatus?: "active" | "paused";
			accountableOwner?: { type: "user" | "tedi"; id: string };
			title?: string;
			riskLevel?: "high" | "critical";
		} = {},
	) {
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
		await db.insert(tedis).values([
			{
				id: approverTedi,
				organizationId: "org",
				name: "Fictional CTO",
				slug: "fictional-cto",
				status: input.tediStatus ?? "active",
			},
			{
				id: "worker-tedi",
				organizationId: "org",
				name: "Fictional worker",
				slug: "fictional-worker",
				status: "active",
			},
		]);
		if (input.designate !== false)
			await db.insert(policyPacks).values({
				id: "pack",
				organizationId: "org",
				name: "Fictional pack",
				slug: "fictional-pack",
				status: "active",
				definition: {
					gatingPolicy: {
						delegationApprover: { type: "tedi", id: approverTedi },
					},
				},
			});
		const [item] = await db
			.insert(workItems)
			.values({
				id: "work",
				orgId: "org",
				title: input.title ?? "Refactor the scheduler",
				disposition: "accepted",
				riskLevel: input.riskLevel ?? "high",
				workClass: "maintenance",
				purposeExceptionExpiresAt: "2099-01-01T00:00:00.000Z",
				admissionSpecRevision: "test-risk-revision",
				accountableOwnerType: input.accountableOwner?.type ?? null,
				accountableOwnerId: input.accountableOwner?.id ?? null,
				createdAt: now,
				updatedAt: now,
			})
			.returning();
		await ensureWorkRiskApproval(db, item!, now);
		const proposals = await db.select().from(workApprovalProposals);
		return { db, item: item!, proposals };
	}

	it.each(["high", "critical"] as const)(
		"routes risk:%s to the tedi, whose approval admits the Work",
		async (riskLevel) => {
			const { db, item, proposals } = await setup({ riskLevel });
			expect(proposals).toHaveLength(1);
			const [proposal] = proposals;
			expect(proposal).toMatchObject({
				approverType: "tedi",
				approverId: approverTedi,
				authorityKey: `risk:${riskLevel}`,
			});
			const readiness = () =>
				deriveWorkItemReadiness(db, {
					orgId: "org",
					workItemId: item.id,
					budgetAdmissible: true,
					resourcesAvailable: true,
					derivedAt: now,
				});
			expect((await readiness()).state).not.toBe("ready");
			await decideWorkApproval(db, {
				id: "decision",
				orgId: "org",
				proposalId: proposal!.id,
				expectedVersion: proposal!.version,
				decision: "approved",
				deciderType: "tedi",
				deciderId: approverTedi,
				rationale: "Bounded scope reviewed",
				now,
			});
			expect((await readiness()).state).toBe("ready");
			const admit = (executorId: string) =>
				evaluateAndRecordWorkAdmission(db, {
					id: `admission-${executorId}`,
					orgId: "org",
					workItemId: item.id,
					expectedWorkItemVersion: item.version,
					expectedAdmissionSpecRevision: item.admissionSpecRevision,
					executorType: "tedi",
					executorId,
					leaseTtlMs: 60_000,
					now,
				});
			// The approver cannot admit itself on its own approval.
			expect(await admit(approverTedi)).toMatchObject({
				decision: "rejected",
				rejectionCode: "approval_blocked",
			});
			expect((await admit("worker-tedi")).decision).toBe("admitted");
		},
	);

	it.each([
		["no tedi is designated", { designate: false }],
		["the tedi is not active", { tediStatus: "paused" as const }],
		[
			"the tedi owns the Work",
			{ accountableOwner: { type: "tedi" as const, id: approverTedi } },
		],
		[
			"the Work names a human-reserved action",
			{ title: "Rotate the production API credentials" },
		],
	])("keeps a human owner when %s", async (_, input) => {
		const { proposals } = await setup(input);
		expect(proposals).toHaveLength(1);
		expect(proposals[0]).toMatchObject({
			approverType: "user",
			approverId: "owner",
		});
	});

	it("hands a lapsed tedi request to a human owner, but not a rejection", async () => {
		const { db, item, proposals } = await setup();
		const later = new Date(Date.parse(now) + 2 * 86400000).toISOString();
		await ensureWorkRiskApproval(db, item, later);
		const after = await db.select().from(workApprovalProposals);
		expect(after.map((row) => row.approverType).sort()).toEqual([
			"tedi",
			"user",
		]);

		const rejected = await setup();
		await decideWorkApproval(rejected.db, {
			id: "decision",
			orgId: "org",
			proposalId: rejected.proposals[0]!.id,
			expectedVersion: rejected.proposals[0]!.version,
			decision: "rejected",
			deciderType: "tedi",
			deciderId: approverTedi,
			rationale: "Scope is unbounded",
			now,
		});
		await ensureWorkRiskApproval(rejected.db, rejected.item, later);
		expect(await rejected.db.select().from(workApprovalProposals)).toHaveLength(
			1,
		);
		expect(proposals).toHaveLength(1);
	});
});
