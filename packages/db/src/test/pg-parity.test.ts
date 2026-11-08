/**
 * Storage-plane parity test: the Work lifecycle story ported to Postgres runs
 * byte-for-byte against both backends — the D1 facade over node:sqlite driving
 * `src/queries/**`, and embedded PGlite driving `src/pg/queries/**`.
 *
 * The lifecycle deliberately crosses every admission/lease fence the story
 * named: create → accept → admit (one Postgres transaction for admission +
 * resource/budget reservations) → start attempt → heartbeat → settle →
 * complete → comment. A stale-version re-admission checks the fencing
 * rejection path is identical on both planes.
 */

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { createD1Facade } from "./d1-facade";
import { schemaDdl } from "./schema-ddl";
import { pgSchemaDdl } from "./pg-schema-ddl";
import { createPgTestDb } from "./pglite-test";

import * as d1Crud from "../queries/work-items/crud";
import * as d1Attempts from "../queries/work-items/attempts";
import * as d1Admissions from "../queries/work-items/admissions";
import * as d1Comments from "../queries/work-items/comments";
import * as pgCrud from "../pg/queries/work-items/crud";
import * as pgAttempts from "../pg/queries/work-items/attempts";
import * as pgAdmissions from "../pg/queries/work-items/admissions";
import * as pgComments from "../pg/queries/work-items/comments";

import { organizations as d1Organizations } from "../schema/organizations";
import { projects as d1Projects } from "../schema/projects";
import { tedis as d1Tedis } from "../schema/tedis";
import {
	orgCapabilities as d1OrgCapabilities,
	capabilityLinks as d1CapabilityLinks,
} from "../schema/capabilities";
import {
	workAttempts as d1WorkAttempts,
	workEvents as d1WorkEvents,
	workItemComments as d1WorkItemComments,
	workItemRelations as d1WorkItemRelations,
	workItems as d1WorkItems,
} from "../schema/work-items";
import {
	workAdmissions as d1WorkAdmissions,
	workApprovalDecisions as d1WorkApprovalDecisions,
	workApprovalProposals as d1WorkApprovalProposals,
	workInteractionResponses as d1WorkInteractionResponses,
	workInteractions as d1WorkInteractions,
	workBudgetEnvelopes as d1WorkBudgetEnvelopes,
	workBudgetReservations as d1WorkBudgetReservations,
	workCaseItems as d1WorkCaseItems,
	workCases as d1WorkCases,
	workMilestones as d1WorkMilestones,
	workResourcePools as d1WorkResourcePools,
	workResourceRequirements as d1WorkResourceRequirements,
	workResourceReservations as d1WorkResourceReservations,
} from "../schema/work-factory";

import { organizations as pgOrganizations } from "../pg/schema/organizations";
import { projects as pgProjects } from "../pg/schema/projects";
import { tedis as pgTedis } from "../pg/schema/tedis";
import {
	orgCapabilities as pgOrgCapabilities,
	capabilityLinks as pgCapabilityLinks,
} from "../pg/schema/capabilities";
import {
	workAttempts as pgWorkAttempts,
	workEvents as pgWorkEvents,
	workItemComments as pgWorkItemComments,
	workItemRelations as pgWorkItemRelations,
	workItems as pgWorkItems,
} from "../pg/schema/work-items";
import {
	workAdmissions as pgWorkAdmissions,
	workApprovalDecisions as pgWorkApprovalDecisions,
	workApprovalProposals as pgWorkApprovalProposals,
	workInteractionResponses as pgWorkInteractionResponses,
	workInteractions as pgWorkInteractions,
	workBudgetEnvelopes as pgWorkBudgetEnvelopes,
	workBudgetReservations as pgWorkBudgetReservations,
	workCaseItems as pgWorkCaseItems,
	workCases as pgWorkCases,
	workMilestones as pgWorkMilestones,
	workResourcePools as pgWorkResourcePools,
	workResourceRequirements as pgWorkResourceRequirements,
	workResourceReservations as pgWorkResourceReservations,
} from "../pg/schema/work-factory";

const NOW = "2026-10-01T00:00:00.000Z";
const IDS = {
	orgId: "11111111-1111-4111-8111-111111111111",
	workItemId: "22222222-2222-4222-8222-222222222222",
	tediId: "33333333-3333-4333-8333-333333333333",
	admissionId: "44444444-4444-4444-8444-444444444444",
};

const SEED = `
INSERT INTO organizations(id,name,slug) VALUES('${IDS.orgId}','Org','org');
INSERT INTO tedis(id,organization_id,name,slug,status) VALUES('${IDS.tediId}','${IDS.orgId}','T','t','active');
`;

interface Plane {
	name: string;
	setup: () => Promise<{
		db: any;
		close: () => Promise<void> | void;
		counts: () => Promise<number[]>;
	}>;
	modules: {
		crud: typeof d1Crud | typeof pgCrud;
		attempts: typeof d1Attempts | typeof pgAttempts;
		admissions: typeof d1Admissions | typeof pgAdmissions;
		comments: typeof d1Comments | typeof pgComments;
	};
}

const planes: Plane[] = [
	{
		name: "d1",
		setup: async () => {
			const sqlite = new DatabaseSync(":memory:");
			sqlite.exec(
				schemaDdl(
					{ foreignKeys: false },
					d1Organizations,
					d1Projects,
					d1Tedis,
					d1OrgCapabilities,
					d1CapabilityLinks,
					d1WorkItems,
					d1WorkItemRelations,
					d1WorkAttempts,
					d1WorkEvents,
					d1WorkInteractions,
					d1WorkInteractionResponses,
					d1WorkItemComments,
					d1WorkResourcePools,
					d1WorkResourceRequirements,
					d1WorkBudgetEnvelopes,
					d1WorkAdmissions,
					d1WorkResourceReservations,
					d1WorkBudgetReservations,
					d1WorkApprovalProposals,
					d1WorkApprovalDecisions,
					d1WorkCases,
					d1WorkCaseItems,
					d1WorkMilestones,
				) + SEED,
			);
			return {
				db: createDbQueryClient(createD1Facade(sqlite)),
				counts: async () =>
					[
						"work_admissions",
						"work_resource_reservations",
						"work_budget_reservations",
						"work_attempts",
					].map((table) =>
						Number(
							sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()
								?.count,
						),
					),
				close: () => sqlite.close(),
			};
		},
		modules: {
			crud: d1Crud,
			attempts: d1Attempts,
			admissions: d1Admissions,
			comments: d1Comments,
		},
	},
	{
		name: "postgres",
		setup: async () => {
			const t = await createPgTestDb(
				pgSchemaDdl(
					{ foreignKeys: false },
					pgOrganizations,
					pgProjects,
					pgTedis,
					pgOrgCapabilities,
					pgCapabilityLinks,
					pgWorkItems,
					pgWorkItemRelations,
					pgWorkAttempts,
					pgWorkEvents,
					pgWorkInteractions,
					pgWorkInteractionResponses,
					pgWorkItemComments,
					pgWorkResourcePools,
					pgWorkResourceRequirements,
					pgWorkBudgetEnvelopes,
					pgWorkAdmissions,
					pgWorkResourceReservations,
					pgWorkBudgetReservations,
					pgWorkApprovalProposals,
					pgWorkApprovalDecisions,
					pgWorkCases,
					pgWorkCaseItems,
					pgWorkMilestones,
				) + SEED,
			);
			return {
				db: t.db,
				close: t.close,
				counts: async () =>
					Promise.all(
						[
							pgWorkAdmissions,
							pgWorkResourceReservations,
							pgWorkBudgetReservations,
							pgWorkAttempts,
						].map(
							async (table) =>
								(await t.db.select({ id: table.id }).from(table)).length,
						),
					),
			};
		},
		modules: {
			crud: pgCrud,
			attempts: pgAttempts,
			admissions: pgAdmissions,
			comments: pgComments,
		},
	},
];

const actor = { type: "user" as const, id: "owner-1" };

for (const plane of planes) {
	describe(`Work lifecycle parity [${plane.name}]`, () => {
		it.each(["omitted", "reset_depth", "weakened_budget"])(
			"rejects %s child policy through the same ancestry gate",
			async (mode) => {
				const { db, close, counts } = await plane.setup();
				try {
					const m = plane.modules;
					const policy = {
						version: 1,
						role: "closure",
						sharedResourceKeys: ["shared"],
						makerResourceKey: "makers",
						reservedSlots: 1,
						budgetEnvelopeIds: ["shared-budget"],
						maxAttempts: 2,
						maxDelegationDepth: 1,
						delegationDepth: 0,
						executors: [
							{
								id: "executor",
								kind: "tedi",
								principalType: "tedi",
								principalId: IDS.tediId,
								resourceKey: "executor",
								costMicros: 10,
								capabilities: [],
							},
						],
					};
					const parent = await m.crud.createWorkItem(db, {
						id: "77777777-7777-4777-8777-777777777777",
						orgId: IDS.orgId,
						title: "Parent",
						workClass: "maintenance",
						purposeExceptionExpiresAt: "2026-11-01T00:00:00.000Z",
						stewardType: "tedi",
						stewardId: IDS.tediId,
						metadata: { laneExecution: policy },
						createdAt: NOW,
					});
					await m.crud.createWorkItem(db, {
						id: IDS.workItemId,
						orgId: IDS.orgId,
						title: "Child",
						workClass: "maintenance",
						purposeExceptionExpiresAt: "2026-11-01T00:00:00.000Z",
						stewardType: "tedi",
						stewardId: IDS.tediId,
						parentWorkItemId: parent.id,
						metadata:
							mode === "omitted"
								? {}
								: {
										laneExecution: {
											...policy,
											delegationDepth: mode === "reset_depth" ? 0 : 1,
											budgetEnvelopeIds:
												mode === "weakened_budget"
													? ["other-budget"]
													: policy.budgetEnvelopeIds,
										},
									},
						createdAt: NOW,
					});
					const child = await m.crud.acceptWorkItem(db, {
						orgId: IDS.orgId,
						workItemId: IDS.workItemId,
						actor,
						acceptanceContract: { version: 1, doneLooksLike: "Checked" },
						acceptedAt: NOW,
					});
					const preview = await m.admissions.previewWorkAdmission(db, {
						orgId: IDS.orgId,
						workItemId: child.id,
						expectedWorkItemVersion: child.version,
						expectedAdmissionSpecRevision: child.admissionSpecRevision,
						executorType: "tedi",
						executorId: IDS.tediId,
						now: NOW,
					});
					expect(preview.rejection?.code).toBe("evaluation_required");
					expect(await counts()).toEqual([0, 0, 0, 0]);
					const admission = await m.admissions.evaluateAndRecordWorkAdmission(
						db,
						{
							id: IDS.admissionId,
							orgId: IDS.orgId,
							workItemId: child.id,
							expectedWorkItemVersion: child.version,
							expectedAdmissionSpecRevision: child.admissionSpecRevision,
							executorType: "tedi",
							executorId: IDS.tediId,
							leaseTtlMs: 60_000,
							now: NOW,
						},
					);
					expect(admission.decision).toBe("rejected");
					expect(admission.rejectionCode).toBe("evaluation_required");
					expect(admission.rejectionReason).toMatch(
						mode === "omitted"
							? /retain/
							: mode === "reset_depth"
								? /depth/
								: /weakens/,
					);
				} finally {
					await close();
				}
			},
		);

		it("create → accept → admit → start → heartbeat → settle → complete → comment", async () => {
			const { db, close, counts } = await plane.setup();
			try {
				const m = plane.modules;
				const item = await m.crud.createWorkItem(db, {
					id: IDS.workItemId,
					orgId: IDS.orgId,
					title: "Parity",
					workClass: "maintenance",
					purposeExceptionExpiresAt: "2026-11-01T00:00:00.000Z",
					stewardType: "tedi",
					stewardId: IDS.tediId,
					createdAt: NOW,
				});
				expect(item.disposition).toBe("proposed");
				expect(item.version).toBe(1);
				expect(item.admissionSpecRevision).toMatch(/^[0-9a-f]{32}$/);

				const accepted = await m.crud.acceptWorkItem(db, {
					orgId: IDS.orgId,
					workItemId: IDS.workItemId,
					acceptanceContract: { version: 1, doneLooksLike: "tests pass" },
					actor,
					acceptedAt: NOW,
				});
				expect(accepted.disposition).toBe("accepted");
				expect(accepted.version).toBe(2);
				const preview = await m.admissions.previewWorkAdmission(db, {
					orgId: IDS.orgId,
					workItemId: IDS.workItemId,
					expectedWorkItemVersion: accepted.version,
					expectedAdmissionSpecRevision: accepted.admissionSpecRevision,
					executorType: "tedi",
					executorId: IDS.tediId,
					now: NOW,
				});
				expect(preview.rejection).toBeUndefined();
				expect(await counts()).toEqual([0, 0, 0, 0]);

				const admission = await m.admissions.evaluateAndRecordWorkAdmission(
					db,
					{
						id: IDS.admissionId,
						orgId: IDS.orgId,
						workItemId: IDS.workItemId,
						expectedWorkItemVersion: accepted.version,
						expectedAdmissionSpecRevision: accepted.admissionSpecRevision,
						executorType: "tedi",
						executorId: IDS.tediId,
						leaseTtlMs: 3_600_000,
						now: NOW,
					},
				);
				expect(admission.decision).toBe("admitted");
				expect(admission.workItemVersion).toBe(2);
				expect(admission.expiresAt).toBe("2026-10-01T01:00:00.000Z");

				const started = await m.attempts.startWorkItemAttempt(db, {
					orgId: IDS.orgId,
					workItemId: IDS.workItemId,
					admissionId: IDS.admissionId,
					executor: { type: "tedi", id: IDS.tediId },
					expiresAt: admission.expiresAt!,
					startedAt: NOW,
				});
				expect(started.attempt.runtimeState).toBe("running");
				expect(started.attempt.attemptNumber).toBe(1);
				expect(started.resumed).toBe(false);

				const beat = await m.attempts.heartbeatWorkItemAttempt(db, {
					orgId: IDS.orgId,
					workItemId: IDS.workItemId,
					attemptId: started.attempt.id,
					executor: { type: "tedi", id: IDS.tediId },
					leaseTtlMs: 3_600_000,
					heartbeatAt: "2026-10-01T00:30:00.000Z",
				});
				expect(beat.expiresAt).toBe("2026-10-01T01:30:00.000Z");

				const settled = await m.attempts.settleWorkItemAttempt(db, {
					orgId: IDS.orgId,
					workItemId: IDS.workItemId,
					attemptId: started.attempt.id,
					executor: { type: "tedi", id: IDS.tediId },
					outcome: "succeeded",
					settledAt: "2026-10-01T00:45:00.000Z",
				});
				expect(settled.attempt.runtimeState).toBe("finished");
				expect(settled.attempt.outcome).toBe("succeeded");

				const comment = await m.comments.addWorkItemComment(db, {
					id: "55555555-5555-4555-8555-555555555555",
					orgId: IDS.orgId,
					workItemId: IDS.workItemId,
					authorType: "user",
					authorId: "owner-1",
					body: "done",
					createdAt: NOW,
					recordActivity: true,
				});
				expect(comment.body).toBe("done");

				const completed = await m.crud.completeWorkItem(db, {
					orgId: IDS.orgId,
					workItemId: IDS.workItemId,
					actor,
					completedAt: "2026-10-01T01:00:00.000Z",
				});
				expect(completed.disposition).toBe("completed");

				// Fencing: a stale version/spec revision records a rejection, not a
				// new admission — the insert-select fence matched no row.
				const rejected = await m.admissions.evaluateAndRecordWorkAdmission(db, {
					id: "66666666-6666-4666-8666-666666666666",
					orgId: IDS.orgId,
					workItemId: IDS.workItemId,
					expectedWorkItemVersion: 1,
					expectedAdmissionSpecRevision: "stale",
					executorType: "tedi",
					executorId: IDS.tediId,
					leaseTtlMs: 3_600_000,
					now: "2026-10-01T02:00:00.000Z",
				});
				expect(rejected.decision).toBe("rejected");
				expect(rejected.rejectionCode).toBe("stale_specification");
			} finally {
				await close();
			}
		});
	});
}
