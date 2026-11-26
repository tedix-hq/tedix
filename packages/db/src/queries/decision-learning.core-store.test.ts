import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../client";
import { coreTable } from "../core-store/client";
import { organizationMembers } from "../schema/organization-members";
import {
	organizations,
	type OrganizationMetadata,
} from "../schema/organizations";
import { projects } from "../schema/projects";
import { tedis } from "../schema/tedis";
import {
	decisionExposures,
	decisionOutcomeLabels,
	learningInteractionEvents,
} from "../schema/learning-feedback";
import { memoryFacts } from "../schema/memory-graph";
import { tediApprovalRequests } from "../schema/approvals";
import {
	workInteractions,
	workInteractionResponses,
} from "../schema/work-factory";
import { createD1Facade } from "../test/d1-facade";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import { createPGliteFacade } from "../test/pglite-facade";
import {
	advanceDecisionLabelScanCheckpoint,
	beginDecisionLabelSweep,
	finishDecisionLabelSweep,
	getDecisionDeferralTime,
	getDecisionExposure,
	getDecisionLabelEvidence,
	getDecisionLearningConfig,
	insertDecisionExposure,
	insertDecisionOutcomeLabel,
	listDecisionInstrumentation,
	listDueDecisionLabels,
	listUnlabelledDecisionApprovals,
	listUnlabelledDecisionDeferrals,
	listUnlabelledDecisionResponses,
	pruneDecisionInstrumentation,
	setDecisionLearningConfig,
} from "./decision-learning";
import { DecisionLearningConfigSchema } from "@tedix/api-contract/schemas/decision-learning";
import type {
	DecisionExposureInput,
	DecisionSnapshot,
} from "@tedix/api-contract/schemas/decision-learning";

for (const store of ["d1", "postgres"] as const)
	describe(`decision learning ${store}`, () => {
		let db: DbClient;
		let close: () => void | Promise<void>;
		const t0 = "2026-11-20T10:00:00.000Z";
		const due = "2026-11-19T00:00:00.000Z";
		const t1 = "2026-11-20T11:00:00.000Z";
		const t2 = "2026-11-20T12:00:00.000Z";
		const t3 = "2026-11-20T12:30:00.000Z";
		const t4 = "2026-11-20T13:00:00.000Z";
		const until = "2026-11-20T14:00:00.000Z";
		const expiry = "2026-12-20T00:00:00.000Z";
		beforeAll(async () => {
			if (store === "d1") {
				const sqlite = createMigratedSqlite();
				db = createDbClient(createD1Facade(sqlite));
				close = () => sqlite.close();
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
			}
			await db
				.insert(coreTable(db, organizations))
				.values({ id: "org", name: "Org", slug: "org" });
			await db.insert(coreTable(db, tedis)).values({
				id: "tedi",
				organizationId: "org",
				name: "Tedi",
				slug: "tedi",
			});
			await db.insert(coreTable(db, organizationMembers)).values({
				id: "mem",
				organizationId: "org",
				userId: "river",
				descopeUserId: "river-descope",
				email: "river@example.com",
				status: "active",
			});
			await db.insert(coreTable(db, projects)).values({
				id: "proj",
				orgId: "org",
				key: "P",
				name: "Project",
				createdAt: t0,
			});
			const cards = coreTable(db, workInteractions);
			await db.insert(cards).values([
				{
					id: "card",
					orgId: "org",
					projectId: "proj",
					kind: "question",
					status: "open",
					subject: "Pick",
					prompt: "Pick one",
					creatorType: "user",
					creatorId: "river",
					targetType: "user",
					targetId: "river",
					version: 1,
					createdAt: t0,
				},
				{
					id: "other-card",
					orgId: "org",
					projectId: "proj",
					kind: "question",
					status: "open",
					subject: "Other",
					prompt: "Other",
					creatorType: "user",
					creatorId: "river",
					targetType: "user",
					targetId: "river",
					version: 1,
					createdAt: t0,
				},
			]);
			const responses = coreTable(db, workInteractionResponses);
			// The response trigger resolves the open request (version 1 -> 2).
			await db.insert(responses).values({
				id: "resp",
				orgId: "org",
				interactionId: "card",
				resolvedRequestVersion: 2,
				resolutionFence: "fence",
				responderType: "user",
				responderId: "river",
				body: "approve",
				responseKind: "answer",
				resolvesRequest: true,
				metadata: { decisionChoice: "approve" },
				respondedAt: t2,
			});
			const exposures = coreTable(db, decisionExposures);
			await db.insert(exposures).values([
				{
					id: "exp",
					organizationId: "org",
					actorId: "river",
					cardId: "card",
					sessionId: "session",
					classId: "cls",
					snapshot: {} as DecisionSnapshot,
					context: { sourceVersion: 1 } as DecisionExposureInput,
					occurredAt: t1,
					expiresAt: expiry,
				},
				{
					id: "exp-approval",
					organizationId: "org",
					actorId: "river",
					cardId: "approval:appr",
					sessionId: "session",
					classId: "cls",
					snapshot: {} as DecisionSnapshot,
					context: {} as DecisionExposureInput,
					occurredAt: t0,
					expiresAt: expiry,
				},
			]);
			const approvals = coreTable(db, tediApprovalRequests);
			await db.insert(approvals).values({
				id: "appr",
				tediId: "tedi",
				orgId: "org",
				actionType: "review",
				description: "Review",
				payload: {},
				status: "approved",
				createdAt: t0,
				expiresAt: expiry,
				resolvedAt: t2,
				resolvedBy: "river",
			});
		}, 30000);
		afterAll(async () => {
			await close?.();
		});

		it("round-trips the tenant config without clobbering other metadata", async () => {
			await db
				.update(coreTable(db, organizations))
				.set({ metadata: { keep: true } as OrganizationMetadata })
				.where(sql`id = 'org'`);
			await setDecisionLearningConfig(
				db,
				"org",
				DecisionLearningConfigSchema.parse({ enabled: true }),
			);
			expect((await getDecisionLearningConfig(db, "org")).enabled).toBe(true);
			const [row] = await db
				.select({ metadata: coreTable(db, organizations).metadata })
				.from(coreTable(db, organizations))
				.where(sql`id = 'org'`);
			expect(row?.metadata).toMatchObject({
				keep: true,
				decisionLearning: { enabled: true },
			});
		});

		it("lists and inserts exposures and instrumentation rows", async () => {
			const [created] = await insertDecisionExposure(db, {
				id: "exp-2",
				organizationId: "org",
				actorId: "river",
				cardId: "other-card",
				sessionId: "session",
				classId: "cls",
				snapshot: {} as DecisionSnapshot,
				context: {} as DecisionExposureInput,
				occurredAt: t3,
				expiresAt: expiry,
			});
			expect(created?.id).toBe("exp-2");
			const listed = await listDecisionInstrumentation(db, {
				organizationId: "org",
				actorId: "river",
				now: t4,
				limit: 10,
			});
			expect(listed.exposures.map((row) => row.id).sort()).toEqual([
				"exp",
				"exp-2",
				"exp-approval",
			]);
			expect(
				await getDecisionExposure(db, {
					organizationId: "org",
					actorId: "river",
					id: "exp",
				}),
			).toMatchObject({ cardId: "card" });
		});

		it("sweeps labelled and unlabelled receipts through sequence/rowid ranges", async () => {
			const responseScan = await beginDecisionLabelSweep(db, "responses", t4);
			expect(responseScan).not.toBeNull();
			const unlabelled = await listUnlabelledDecisionResponses(
				db,
				t4,
				50,
				null,
				{
					afterRowid: 0,
					throughRowid: responseScan!.throughRowid,
				},
			);
			expect(unlabelled.map((row) => row.responseId)).toEqual(["resp"]);
			const approvalScan = await beginDecisionLabelSweep(db, "approvals", t4);
			expect(approvalScan).not.toBeNull();
			const approvals = await listUnlabelledDecisionApprovals(
				db,
				t4,
				50,
				null,
				{
					afterRowid: 0,
					throughRowid: approvalScan!.throughRowid,
				},
			);
			expect(approvals.map((row) => row.receiptId)).toEqual(["appr"]);
			await finishDecisionLabelSweep(db, responseScan!, t4, 0, 50);
			expect(
				await insertDecisionOutcomeLabel(db, {
					id: "org:resp:immediate",
					organizationId: "org",
					actorId: "river",
					cardId: "card",
					classId: "cls",
					window: "immediate",
					outcome: {
						label: "unchanged_approval",
						evidenceSource: "canonical_receipt",
						reason: null,
						exposureId: "exp",
						receiptId: "resp",
						decidedAt: t2,
						laterToDecisionMs: null,
					},
					observedAt: t4,
					dueAt: due,
					expiresAt: expiry,
				}),
			).toBe(true);
			expect(
				await listUnlabelledDecisionResponses(db, t4, 50, null, {
					afterRowid: 0,
					throughRowid: responseScan!.throughRowid,
				}),
			).toEqual([]);
			const dueLabels = await listDueDecisionLabels(db, t4, "day_1");
			expect(dueLabels.map((row) => row.id)).toEqual(["org:resp:immediate"]);
		});

		it("reads deferral, evidence and follow-up signals across the dialect boundary", async () => {
			const events = coreTable(db, learningInteractionEvents);
			const [defer] = await db
				.insert(events)
				.values({
					organizationId: "org",
					actorType: "user",
					actorId: "river",
					clientEventId: "defer",
					eventKind: "accepted",
					scopeKind: "personal",
					scopeId: "river",
					surface: "decision_deck",
					targetId: "card",
					metadata: { decisionChoice: "later" },
					occurredAt: t1,
				})
				.returning({ id: events.id });
			const [signal] = await db
				.insert(events)
				.values({
					organizationId: "org",
					actorType: "user",
					actorId: "river",
					clientEventId: "signal",
					eventKind: "accepted",
					scopeKind: "personal",
					scopeId: "river",
					surface: "decision_deck",
					targetId: "card",
					metadata: { serverObserved: true },
					occurredAt: t3,
				})
				.returning({ id: events.id });
			const facts = coreTable(db, memoryFacts);
			await db.insert(facts).values({
				id: "lesson",
				organizationId: "org",
				content: "Lesson",
				factType: "decision",
				metadata: {
					learningFeed: {
						ownerUserId: "river",
						evidenceEventIds: [signal!.id],
					},
				},
				createdAt: t4,
			});
			expect(
				await getDecisionDeferralTime(db, {
					organizationId: "org",
					actorId: "river",
					cardId: "card",
					before: t2,
				}),
			).toBe(t1);
			expect(
				(await listUnlabelledDecisionDeferrals(db, t4)).map(
					(row) => row.eventId,
				),
			).toEqual([defer!.id]);
			const evidence = await getDecisionLabelEvidence(db, {
				organizationId: "org",
				actorId: "river",
				cardId: "card",
				receiptId: "resp",
				exposureId: "exp",
				decidedAt: t2,
				until,
			});
			expect(evidence.events.map((row) => row.id)).toEqual([signal!.id]);
			expect(evidence.lessons.map((row) => row.id)).toEqual(["lesson"]);
			expect(evidence.work).toBeNull();
			expect(evidence.followUps).toEqual([]);
		});

		it("prunes expired instrumentation", async () => {
			await pruneDecisionInstrumentation(db, "2027-01-01T00:00:00.000Z");
			expect(
				await getDecisionExposure(db, {
					organizationId: "org",
					actorId: "river",
					id: "exp",
				}),
			).toBeNull();
			expect(
				await listDueDecisionLabels(db, "2027-01-01T00:00:00.000Z", "day_1"),
			).toEqual([]);
			await advanceDecisionLabelScanCheckpoint(
				db,
				"responses:sweep",
				null,
				"{}",
			);
		});
	});
