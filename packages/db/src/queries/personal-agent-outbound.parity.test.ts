import { readMigrationFiles } from "drizzle-orm/migrator";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import type {
	PersonalAgentEnrollment,
	PersonalAgentOutcome,
} from "@tedix/api-contract/schemas/personal-agent-inbound";
import { coreTable } from "../core-store/client";
import { createDbQueryClient, type DbQueryClient } from "../query-client";
import { userConfigs } from "../schema/user-configs";
import { organizationMembers } from "../schema/organization-members";
import { tediEmailAddresses } from "../schema/tedi-email";
import { tedis } from "../schema/tedis";
import { organizations } from "../schema/organizations";
import { projects } from "../schema/projects";
import {
	workItems,
	workEvents,
	workItemComments,
	workEvidence,
	workEvidenceVerifications,
} from "../schema/work-items";
import {
	workInteractions,
	workInteractionResponses,
} from "../schema/work-factory";
import { createD1Facade } from "../test/d1-facade";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import { createPGliteFacade } from "../test/pglite-facade";
import {
	acknowledgePersonalAgentOutcome,
	claimPersonalAgentEmail,
	finishPersonalAgentEmail,
	getPersonalAgentEmailDestination,
	getPersonalAgentValue,
	listPendingPersonalAgentEmails,
	listPersonalAgentOutcomeSources,
	listPersonalAgentOutcomes,
	recordPersonalAgentOutcome,
} from "./personal-agent-outbound";

const at = "2026-11-20T12:00:00.000Z";
const enrollment: PersonalAgentEnrollment = {
	id: "11111111-1111-4111-8111-111111111111",
	orgId: "org",
	projectId: "project",
	representedUserId: "person",
	sourceAgentName: "Scout",
	secretName: "fictional-secret",
	active: true,
	createdAt: at,
	delivery: {
		workComment: true,
		email: { memberId: "agent-member", senderAddressId: "sender" },
	},
};
const outcome: PersonalAgentOutcome = {
	id: "pa-outcome:response:decision",
	sourceAgentId: enrollment.id,
	externalFindingId: "finding",
	workItemId: "work",
	interactionId: "interaction",
	responseId: "response",
	decision: "Approved",
	option: null,
	decidedBy: "person",
	decidedAt: at,
	sourceVersion: 2,
	correctsResponseId: null,
	supersedes: null,
	recordedAt: at,
	execution: {
		state: "verified",
		evidenceId: null,
		evidenceUri: null,
		evidenceVersion: null,
		observationSource: null,
		observerType: null,
		observerId: null,
		verificationId: null,
		observedAt: null,
	},
};

for (const store of ["d1", "postgres"] as const)
	describe(`personal outbound ${store}`, () => {
		let db: DbQueryClient;
		let close: () => void | Promise<void>;
		let rejectComment: () => Promise<void>;
		beforeAll(async () => {
			if (store === "d1") {
				const sqlite = createMigratedSqlite();
				db = createDbQueryClient(
					createD1Facade(sqlite, { maxBoundParams: 100 }),
				);
				close = () => sqlite.close();
				rejectComment = async () => {
					sqlite.exec(`CREATE TRIGGER reject_outbound_fixture BEFORE INSERT ON work_item_comments
					 WHEN NEW.id='rollback' BEGIN SELECT RAISE(ABORT,'fixture comment failure'); END;`);
				};
			} else {
				const fixture = await createPGliteFacade();
				db = fixture.db;
				close = fixture.close;
				for (const migration of readMigrationFiles({
					migrationsFolder: fileURLToPath(
						new URL("../../drizzle-pg", import.meta.url),
					),
				}))
					for (const ddl of migration.sql) await fixture.engine.exec(ddl);
				rejectComment = async () => {
					await fixture.engine.exec(`
					 CREATE FUNCTION reject_outbound_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
					 BEGIN IF NEW.id='rollback' THEN RAISE EXCEPTION 'fixture comment failure'; END IF; RETURN NEW; END; $$;
					 CREATE TRIGGER reject_outbound_fixture BEFORE INSERT ON work_item_comments
					 FOR EACH ROW EXECUTE FUNCTION reject_outbound_fixture();
					`);
				};
			}
			await db
				.insert(coreTable(db, organizations))
				.values({ id: "org", name: "Org", slug: "org" });
			await db.insert(coreTable(db, projects)).values({
				id: "project",
				orgId: "org",
				key: "TEST",
				name: "Project",
				createdAt: at,
			});
			await db.insert(coreTable(db, tedis)).values({
				id: "tedi",
				organizationId: "org",
				name: "Tedi",
				slug: "tedi",
			});
			await db.insert(coreTable(db, organizationMembers)).values([
				{
					id: "person-member",
					organizationId: "org",
					userId: "person",
					descopeUserId: "person",
					email: "person@example.test",
					status: "active",
					role: "owner",
				},
				{
					id: "agent-member",
					organizationId: "org",
					userId: "agent",
					descopeUserId: "agent",
					representedUserId: "person",
					kind: "external_agent",
					email: "agent@example.test",
					status: "active",
					role: "member",
				},
			]);
			await db.insert(coreTable(db, tediEmailAddresses)).values({
				id: "sender",
				organizationId: "org",
				tediId: "tedi",
				address: "scout@example.test",
				localPart: "scout",
				domain: "example.test",
				kind: "primary",
				status: "active",
				createdBy: "person",
			});
			await db.insert(coreTable(db, userConfigs)).values({
				id: "config",
				userId: "person",
				namespace: "personal-agent-inbound.v1",
				key: `org:${enrollment.id}`,
				value: enrollment,
			});
			await db.insert(coreTable(db, workItems)).values({
				id: "work",
				orgId: "org",
				projectId: "project",
				title: "Finding",
				workKind: "coding",
				admissionSpecRevision: "fixture-admission",
				accountableOwnerType: "user",
				accountableOwnerId: "person",
				createdAt: at,
				updatedAt: at,
				provenance: {
					personalAgentContribution: {
						sourceAgentId: enrollment.id,
						representedUserId: "person",
						externalFindingId: "finding",
						kind: "proposal",
					},
				},
			});
			await db.insert(coreTable(db, workInteractions)).values({
				id: "interaction",
				orgId: "org",
				workItemId: "work",
				kind: "question",
				subject: "Review",
				prompt: "Approve?",
				creatorType: "user",
				creatorId: "person",
				targetType: "user",
				targetId: "person",
				createdAt: at,
				metadata: {
					source: "personal-agent-inbound",
					decisionDeck: { version: 1 },
				},
			});
			await db.insert(coreTable(db, workInteractionResponses)).values({
				id: "response",
				orgId: "org",
				interactionId: "interaction",
				resolvedRequestVersion: 2,
				resolutionFence: "response",
				responderType: "user",
				responderId: "person",
				body: "Approved",
				responseKind: "answer",
				resolvesRequest: true,
				respondedAt: at,
				metadata: { cardAction: "approve" },
			});
		}, 30000);
		afterAll(async () => {
			await close?.();
		});

		it("reads the direct human response and keeps JSON string and numeric result types", async () => {
			const rows = await listPersonalAgentOutcomeSources(db);
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				responseId: "response",
				sourceVersion: 2,
				sourceKey: "response:decision",
			});
			expect(JSON.parse(rows[0]!.enrollment)).toMatchObject({
				active: true,
				representedUserId: "person",
			});
			expect(JSON.parse(rows[0]!.contribution)).toMatchObject({
				kind: "proposal",
			});
			expect(JSON.parse(rows[0]!.metadata)).toEqual({ cardAction: "approve" });
		});

		it("writes outcome/comment once in one batch and rolls back a failed dependent comment", async () => {
			const batch = vi.spyOn(db, "batch");
			await recordPersonalAgentOutcome(db, "org", outcome);
			expect(batch).toHaveBeenCalledTimes(1);
			await recordPersonalAgentOutcome(db, "org", outcome);
			batch.mockRestore();
			const comments = await db
				.select()
				.from(coreTable(db, workItemComments))
				.where(eq(coreTable(db, workItemComments).id, outcome.id));
			expect(comments).toHaveLength(1);
			expect(JSON.parse(comments[0]!.body)).toMatchObject({
				decision: "Approved",
			});
			expect(comments[0]!.metadata).toMatchObject({
				personalAgentOutcome: { decision: "Approved" },
			});
			expect(await listPersonalAgentOutcomeSources(db)).toEqual([]);
			await rejectComment();
			await expect(
				recordPersonalAgentOutcome(db, "org", { ...outcome, id: "rollback" }),
			).rejects.toThrow();
			expect(
				await db
					.select()
					.from(coreTable(db, workEvents))
					.where(eq(coreTable(db, workEvents).id, "rollback")),
			).toEqual([]);
		});

		it("fences email claims and acknowledgements to the configured owner and enrollment", async () => {
			expect(await getPersonalAgentEmailDestination(db, enrollment)).toEqual({
				to: "agent@example.test",
				from: "scout@example.test",
			});
			const pending = await listPendingPersonalAgentEmails(db);
			expect(pending).toHaveLength(1);
			expect(JSON.parse(pending[0]!.payload)).toMatchObject({ id: outcome.id });
			expect(await claimPersonalAgentEmail(db, enrollment, outcome)).toBe(true);
			expect(await claimPersonalAgentEmail(db, enrollment, outcome)).toBe(
				false,
			);
			await finishPersonalAgentEmail(db, "org", outcome.id, { status: "sent" });
			expect(await listPendingPersonalAgentEmails(db)).toEqual([]);
			expect(
				await acknowledgePersonalAgentOutcome(db, {
					orgId: "org",
					userId: "other",
					enrollmentId: enrollment.id,
					outcomeId: outcome.id,
				}),
			).toBe(false);
			expect(
				await acknowledgePersonalAgentOutcome(db, {
					orgId: "org",
					userId: "person",
					enrollmentId: enrollment.id,
					outcomeId: outcome.id,
					reminderId: "reminder",
				}),
			).toBe(true);
			expect(
				await listPersonalAgentOutcomes(db, {
					orgId: "org",
					userId: "person",
					enrollmentId: enrollment.id,
				}),
			).toMatchObject([
				{ emailStatus: "sent", acknowledgedAt: expect.any(String) },
			]);
			expect(
				await listPersonalAgentOutcomes(db, {
					orgId: "other",
					userId: "person",
					enrollmentId: enrollment.id,
				}),
			).toEqual([]);
		});

		it("returns numeric cohort counts without counting an agent acknowledgement as human approval", async () => {
			expect(
				await getPersonalAgentValue(db, enrollment, "2026-11-01", "9999-01-01"),
			).toMatchObject({
				findings: 1,
				decisionFindings: 1,
				decisionCards: 1,
				decidedFromCard: 1,
				outcomes: 1,
				verifiedOutcomes: 1,
				emailsSent: 1,
				acknowledgedOutcomes: 1,
				agentReportedReminderRetirements: 1,
			});
		});

		it("keeps boolean verification observations and evidence-version comparisons in the backlog", async () => {
			const evidence = coreTable(db, workEvidence);
			await db.insert(evidence).values({
				id: "evidence",
				orgId: "org",
				workItemId: "work",
				claimKey: "claim",
				kind: "url",
				uri: "https://example.test/proof",
				submittedByType: "user",
				submittedById: "person",
				submittedAt: at,
			});
			await db
				.update(evidence)
				.set({ version: 2 })
				.where(eq(evidence.id, "evidence"));
			await db.insert(coreTable(db, workEvidenceVerifications)).values([
				{
					id: "verified",
					orgId: "org",
					workItemId: "work",
					evidenceId: "evidence",
					source: "checker-a",
					verifierType: "system",
					verifierId: "checker",
					claimed: { evidenceVersion: "2" },
					matchesClaim: true,
					observedAt: at,
				},
				{
					id: "contradicted",
					orgId: "org",
					workItemId: "work",
					evidenceId: "evidence",
					source: "checker-b",
					verifierType: "system",
					verifierId: "checker",
					matchesClaim: false,
					observedAt: at,
				},
			]);
			const rows = await listPersonalAgentOutcomeSources(db);
			expect(rows.map((row) => row.observationState).sort()).toEqual([
				"contradicted",
				"verified",
			]);
			expect(
				rows.find((row) => row.verificationId === "verified"),
			).toMatchObject({
				evidenceVersion: "2",
				sourceKey: `response:verified:${at}:1:2`,
			});
		});

		it("stops new outbound writes when the enrollment becomes inactive", async () => {
			await db
				.update(coreTable(db, userConfigs))
				.set({ value: { ...enrollment, active: false } })
				.where(eq(coreTable(db, userConfigs).id, "config"));
			await recordPersonalAgentOutcome(db, "org", {
				...outcome,
				id: "inactive",
			});
			expect(
				await db
					.select()
					.from(coreTable(db, workEvents))
					.where(eq(coreTable(db, workEvents).id, "inactive")),
			).toEqual([]);
			expect(
				await claimPersonalAgentEmail(db, enrollment, {
					...outcome,
					id: "inactive",
				}),
			).toBe(false);
		});
	});
