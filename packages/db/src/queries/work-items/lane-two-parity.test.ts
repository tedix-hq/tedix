import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { coreTable } from "../../core-store/client";
import type { DbQueryClient } from "../../query-client";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { createMigratedSqlite } from "../../test/migrated-sqlite";
import { createPGliteFacade } from "../../test/pglite-facade";
import { organizations } from "../../schema/organizations";
import { projects } from "../../schema/projects";
import { tedis } from "../../schema/tedis";
import {
	workAdmissions,
	workApprovalProposals,
} from "../../schema/work-factory";
import {
	workAttemptSteps,
	workAttempts,
	workItems,
} from "../../schema/work-items";
import { getWorkApprovalProposal } from "./approvals";
import { deriveWorkItemReadiness } from "./readiness";
import {
	appendWorkAttemptSteps,
	listWorkAttemptSteps,
	sendWorkAttemptMessage,
} from "./attempt-steps";
import {
	heartbeatWorkItemAttempt,
	listLiveWorkAttemptHolders,
	listWorkItemAttempts,
} from "./attempts";
import {
	createWorkBudgetEnvelope,
	getWorkBudgetEnvelopeByScope,
	listWorkBudgetEnvelopes,
	markCreditBudgetAlerted,
	updateWorkBudgetEnvelope,
} from "./budgets";
import {
	createWorkResourcePool,
	getWorkResourcePoolByKey,
	listActiveWorkResourceHolders,
	listWorkResourcePools,
	updateWorkResourcePool,
} from "./resources";
import { readWorkWaitPage } from "./wait";

const at = "2026-11-25T12:00:00.000Z";
const expires = "2099-01-01T00:00:00.000Z";
const executor = { type: "tedi" as const, id: "gardener" };
for (const store of ["d1", "postgres"] as const)
	describe(store, () => {
		let db: DbQueryClient;
		let close: () => void | Promise<void>;
		beforeAll(async () => {
			if (store === "postgres") {
				const fixture = await createPGliteFacade();
				db = fixture.db;
				close = fixture.close;
				for (const migration of readMigrationFiles({
					migrationsFolder: fileURLToPath(
						new URL("../../../drizzle-pg", import.meta.url),
					),
				}))
					for (const ddl of migration.sql) await fixture.engine.exec(ddl);
			} else {
				const sqlite = createMigratedSqlite();
				db = createDbQueryClient(
					createD1Facade(sqlite, { maxBoundParams: 100 }),
				);
				close = () => {
					if (sqlite.isOpen) sqlite.close();
				};
			}
			await db.insert(coreTable(db, organizations)).values({
				id: "orchard",
				name: "Orchard",
				slug: "orchard",
			});
			await db.insert(coreTable(db, tedis)).values({
				id: "gardener",
				organizationId: "orchard",
				name: "Gardener",
				slug: "gardener",
				status: "active",
			});
			await db.insert(coreTable(db, projects)).values({
				id: "trees",
				orgId: "orchard",
				key: "TREES",
				name: "Trees",
				createdAt: at,
			});
			await db.insert(coreTable(db, workItems)).values({
				id: "task",
				orgId: "orchard",
				projectId: "trees",
				title: "Harvest",
				disposition: "accepted",
				admissionSpecRevision: "spec-task",
				createdAt: at,
			});
			await db.insert(coreTable(db, workAdmissions)).values({
				id: "admission",
				orgId: "orchard",
				workItemId: "task",
				workItemVersion: 1,
				admissionSpecRevision: "spec-task",
				executorType: "tedi",
				executorId: "gardener",
				decision: "admitted",
				decidedAt: at,
				expiresAt: expires,
				createdAt: at,
			});
			await db.insert(coreTable(db, workAttempts)).values({
				id: "attempt",
				orgId: "orchard",
				workItemId: "task",
				admissionId: "admission",
				executorType: "tedi",
				executorId: "gardener",
				attemptNumber: 1,
				runtimeState: "running",
				startedAt: at,
				heartbeatAt: at,
				expiresAt: expires,
			});
		}, 30000);
		afterAll(async () => {
			await close?.();
		});

		it("creates, reads and updates budget envelopes on both stores", async () => {
			const org = await createWorkBudgetEnvelope(db, {
				id: "env-org",
				orgId: "orchard",
				scopeType: "organization",
				scopeId: "orchard",
				limitMicros: 1_000_000,
				reservationMicros: 100_000,
				now: at,
			});
			expect(org).toMatchObject({ version: 1, enabled: true });
			await createWorkBudgetEnvelope(db, {
				id: "env-project",
				orgId: "orchard",
				scopeType: "project",
				scopeId: "trees",
				limitMicros: 500_000,
				reservationMicros: 0,
				currency: "credits",
				now: at,
			});
			expect(
				await getWorkBudgetEnvelopeByScope(db, {
					orgId: "orchard",
					scopeType: "organization",
					scopeId: "orchard",
				}),
			).toMatchObject({ id: "env-org" });
			expect(
				(
					await updateWorkBudgetEnvelope(db, {
						orgId: "orchard",
						envelopeId: "env-org",
						expectedVersion: 1,
						limitMicros: 2_000_000,
						now: at,
					})
				).version,
			).toBe(2);
			expect(
				await markCreditBudgetAlerted(db, {
					orgId: "orchard",
					envelopeId: "env-project",
					limitMicros: 500_000,
					percent: 80,
				}),
			).toMatchObject({ alertedPercent: 80 });
			expect(
				await markCreditBudgetAlerted(db, {
					orgId: "orchard",
					envelopeId: "env-project",
					limitMicros: 500_000,
					percent: 80,
				}),
			).toBeNull();
			const page = await listWorkBudgetEnvelopes(db, {
				orgId: "orchard",
				at,
			});
			expect(page.data.map((row) => row.id).sort()).toEqual([
				"env-org",
				"env-project",
			]);
		});

		it("creates, reads and updates resource pools on both stores", async () => {
			const pool = await createWorkResourcePool(db, {
				id: "pool-gpu",
				orgId: "orchard",
				resourceKey: "gpu",
				allocationMode: "capacity",
				capacity: 2,
				now: at,
			});
			expect(pool).toMatchObject({ version: 1, enabled: true });
			expect(
				await getWorkResourcePoolByKey(db, {
					orgId: "orchard",
					resourceKey: "gpu",
				}),
			).toMatchObject({ id: "pool-gpu" });
			expect(
				(
					await updateWorkResourcePool(db, {
						orgId: "orchard",
						poolId: "pool-gpu",
						expectedVersion: 1,
						capacity: 4,
						now: at,
					})
				).capacity,
			).toBe(4);
			const page = await listWorkResourcePools(db, { orgId: "orchard", at });
			expect(page.data).toHaveLength(1);
			expect(page.data[0]).toMatchObject({
				pool: { id: "pool-gpu" },
				activeReserved: 0,
				effectiveAvailable: 4,
			});
			expect(
				await listActiveWorkResourceHolders(db, {
					orgId: "orchard",
					poolIds: ["pool-gpu", "missing"],
					at,
				}),
			).toEqual([]);
		});

		it("stores attempt steps and messages and pages wait cursors identically", async () => {
			const appended = await appendWorkAttemptSteps(db, {
				orgId: "orchard",
				workItemId: "task",
				attemptId: "attempt",
				executor,
				steps: [{ seq: 1, at: 1, kind: "message", text: "Working" }],
				at,
			});
			expect(appended.accepted).toBe(1);
			const listed = await listWorkAttemptSteps(db, {
				orgId: "orchard",
				workItemId: "task",
				attemptId: "attempt",
				at,
			});
			expect(listed.steps.map((step) => step.seq)).toEqual([1]);
			expect(listed.live).toBe(true);
			const first = await readWorkWaitPage(db, {
				orgId: "orchard",
				workItemId: "task",
			});
			const message = await sendWorkAttemptMessage(db, {
				orgId: "orchard",
				workItemId: "task",
				attemptId: "attempt",
				kind: "follow_up",
				body: "Please hurry",
				sender: { type: "user", id: "person" },
				at,
			});
			expect(message).toMatchObject({ kind: "follow_up" });
			const second = await readWorkWaitPage(db, {
				orgId: "orchard",
				workItemId: "task",
				cursor: first.cursor,
			});
			expect(second.changes.some((change) => change.kind === "message")).toBe(
				true,
			);
		});

		it("lists attempts and live holders and reads approval proposals", async () => {
			const attempts = await listWorkItemAttempts(db, {
				orgId: "orchard",
				workItemId: "task",
			});
			expect(attempts.data.map((attempt) => attempt.id)).toEqual(["attempt"]);
			const readiness = await deriveWorkItemReadiness(db, {
				orgId: "orchard",
				workItemId: "task",
				derivedAt: at,
			});
			expect(
				readiness.gates.find((gate) => gate.gate === "attempt"),
			).toMatchObject({
				evaluation: "failed",
				detail: "Active attempt attempt",
			});
			const holders = await listLiveWorkAttemptHolders(db, {
				orgId: "orchard",
			});
			expect(holders.get("task")).toMatchObject({
				attemptId: "attempt",
				executorId: "gardener",
			});
			expect(
				await getWorkApprovalProposal(db, {
					orgId: "orchard",
					proposalId: "missing",
				}),
			).toBeNull();
			expect(
				(
					await db
						.select({ id: workApprovalProposals.id })
						.from(coreTable(db, workApprovalProposals))
				).length,
			).toBe(0);
			expect(
				(
					await db
						.select({ id: workAttemptSteps.id })
						.from(coreTable(db, workAttemptSteps))
				).length,
			).toBe(1);
		});

		it("heartbeats the attempt and extends reservations in one batch", async () => {
			const beat = await heartbeatWorkItemAttempt(db, {
				orgId: "orchard",
				workItemId: "task",
				attemptId: "attempt",
				executor,
				heartbeatAt: "2026-11-25T12:30:00.000Z",
				leaseTtlMs: 600_000,
			});
			expect(beat.expiresAt).toBe("2026-11-25T12:40:00.000Z");
		});
	});
