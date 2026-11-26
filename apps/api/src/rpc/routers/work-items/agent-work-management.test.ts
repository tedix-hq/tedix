import { DatabaseSync } from "node:sqlite";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { canonicalWorkFactoryDdl, schemaDdl } from "@tedix/db/test/schema-ddl";
import { externalAgentPrincipals } from "@tedix/db/schema/external-agent-identity";
import { gitCommitAliases } from "@tedix/db/schema/git-commit-aliases";
import {
	workAttempts,
	workEvents,
	workAttemptSteps,
	workAttemptMessages,
	workEvidence,
} from "@tedix/db/schema/work-items";
import {
	WorkAttemptSettlementSchema,
	type WorkAttemptSettlement,
} from "@tedix/api-contract/schemas/work-items";
import {
	workAdmissions,
	workResourceReservations,
	workBudgetReservations,
	workInteractions,
} from "@tedix/db/schema/work-factory";
import {
	createWorkItem,
	getWorkItemById,
} from "@tedix/db/queries/work-items/crud";
import type { BaseContext } from "../../orpc";
import { workItemStewardActor } from "./policy-helpers";
import { hasRecoveredCommitCustody } from "./recovered-commit-custody";
import {
	cancelFactoryWorkItemProcedure,
	completeProcedure,
	settleAttemptProcedure,
	updateSpecificationProcedure,
} from "./factory-lifecycle";

const { session } = vi.hoisted(() => ({ session: vi.fn() }));
const native = vi.hoisted(() => ({
	output: vi.fn(),
	revision: vi.fn(),
	gadget: vi.fn(),
	code: vi.fn(),
}));
vi.mock("../../../services/workspace-output-storage", () => ({
	getOsOutput: native.output,
	getOsOutputRevision: native.revision,
}));
vi.mock("@tedix/db/queries/os-workspaces/gadgets", () => ({
	getOsGadget: native.gadget,
}));
vi.mock("../../../services/os-app-runtime-code", () => ({
	loadAppRuntimeRevision: native.code,
}));
vi.mock(
	"@tedix/db/queries/external-agent-identity/mcp-credentials",
	async (original) => ({
		...(await original<
			typeof import("@tedix/db/queries/external-agent-identity/mcp-credentials")
		>()),
		resolveAuthorizedExternalAgentMcpSession: session,
	}),
);
const id = "11111111-1111-4111-8111-111111111111";
const databases: DatabaseSync[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});

async function fixture({
	prefixes = ["repair:"],
	actions = ["specification", "assignment", "cancellation"],
	principalOrg = "org",
	status = "active" as "active" | "retired",
} = {}) {
	const sqlite = new DatabaseSync(":memory:");
	databases.push(sqlite);
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		canonicalWorkFactoryDdl() +
			schemaDdl(
				gitCommitAliases,
				externalAgentPrincipals,
				workEvents,
				workAttemptSteps,
				workAttemptMessages,
				workAdmissions,
				workResourceReservations,
				workBudgetReservations,
				workInteractions,
				workEvidence,
			),
	);
	sqlite.exec(
		"INSERT INTO organizations(id,name,slug) VALUES('org','Org','org')",
	);
	const db = createDbClient(createD1Facade(sqlite));
	await db.insert(externalAgentPrincipals).values({
		id: "bot",
		organizationId: principalOrg,
		key: "repair-bot",
		displayName: "Repair bot",
		status,
		credentialBindingType: "github_actions_oidc",
		credentialBindingId: "repo:example/repo:environment:repair",
		createdByType: "user",
		createdById: "owner",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		metadata: { workManagement: { sourceIntentPrefixes: prefixes, actions } },
	});
	const item = await createWorkItem(db, {
		id,
		orgId: "org",
		title: "Repair test failure",
		sourceIntentId: "repair:example",
		createdAt: new Date().toISOString(),
	});
	session.mockResolvedValue({
		session: {
			externalSessionKey: "github-actions:example",
			harness: "github-actions",
			creditEligible: false,
		},
	});
	const context = {
		db,
		organizationId: "org",
		authType: "service-binding",
		headers: new Headers(),
		externalAgentPrincipalId: "bot",
		externalAgentSessionId: "session",
		externalAgentClientRecordId: "client",
	} as BaseContext;
	const update = (input: {
		id: string;
		executor?: "codex";
		description?: string;
		projectId?: string;
		riskLevel?: "low";
		expectedWorkItemVersion?: number;
	}) =>
		updateSpecificationProcedure["~orpc"].handler!({
			context,
			input,
			path: [],
			procedure: updateSpecificationProcedure,
			signal: undefined,
			lastEventId: undefined,
		});
	return { db, sqlite, context, item, update };
}

describe("verified native artifact completion", () => {
	it.each(["native_sheet_revision", "runtime_app_revision"] as const)(
		"atomically completes %s without a commit and refuses invalid proof",
		async (mode) => {
			const { db, sqlite, context } = await fixture();
			const workspaceId = "22222222-2222-4222-8222-222222222222";
			const artifactId = "33333333-3333-4333-8333-333333333333";
			const revisionId = "44444444-4444-4444-8444-444444444444";
			const evidenceId = "55555555-5555-4555-8555-555555555555";
			const target = { workspaceId, revisionId, revision: 3 };
			const proof: WorkAttemptSettlement =
				mode === "native_sheet_revision"
					? {
							mode,
							...target,
							outputId: artifactId,
							evidenceId,
							evidenceUri: `tedix://workspaces/${workspaceId}/outputs/${artifactId}/revisions/${revisionId}`,
						}
					: {
							mode,
							...target,
							gadgetId: artifactId,
							evidenceId,
							evidenceUri: `tedix://workspaces/${workspaceId}/gadgets/${artifactId}/revisions/${revisionId}`,
						};
			const metadata =
				mode === "native_sheet_revision"
					? {
							artifactKind: mode,
							artifactNativeSheet: { ...target, outputId: artifactId },
						}
					: {
							artifactKind: mode,
							artifactRuntimeApp: { ...target, gadgetId: artifactId },
						};
			const contract = {
				version: 1,
				doneLooksLike: "The native result is saved and verified.",
			};
			sqlite
				.prepare(
					"UPDATE work_items SET disposition='accepted',work_kind='coding',acceptance_contract=?,metadata=? WHERE id=?",
				)
				.run(JSON.stringify(contract), JSON.stringify(metadata), id);
			const now = new Date().toISOString();
			await db.insert(workAdmissions).values({
				id: "native-admission",
				orgId: "org",
				workItemId: id,
				workItemVersion: 1,
				admissionSpecRevision: (await getWorkItemById(db, id))!
					.admissionSpecRevision,
				executorType: "external_agent",
				executorId: "bot",
				executorSessionId: "session",
				externalSessionKey: "github-actions:example",
				decision: "admitted",
				createdAt: now,
				decidedAt: now,
				expiresAt: new Date(Date.now() + 300000).toISOString(),
			});
			await db.insert(workAttempts).values({
				id: "native-attempt",
				admissionId: "native-admission",
				orgId: "org",
				workItemId: id,
				executorType: "external_agent",
				executorId: "bot",
				executorSessionId: "session",
				externalSessionKey: "github-actions:example",
				attemptNumber: 1,
				startedAt: now,
				heartbeatAt: now,
				expiresAt: new Date(Date.now() + 300000).toISOString(),
			});
			await db.insert(workEvidence).values({
				id: evidenceId,
				orgId: "org",
				workItemId: id,
				attemptId: "native-attempt",
				claimKey: "delivery",
				kind: mode,
				uri: proof.evidenceUri,
				submittedByType: "external_agent",
				submittedById: "bot",
				submittedAt: now,
			});
			native.output.mockResolvedValue({
				status: "active",
				kind: "sheet",
				currentRevisionId: revisionId,
			});
			native.revision.mockResolvedValue({
				id: revisionId,
				organizationId: "org",
				outputId: artifactId,
				revision: 3,
				content: JSON.stringify({
					kind: "sheet",
					columns: ["Result"],
					rows: [["Verified"]],
				}),
			});
			native.gadget.mockResolvedValue({
				status: "active",
				workspaceId,
				currentRevisionId: revisionId,
			});
			native.code.mockResolvedValue({
				revision: 3,
				files: {
					"client.js": "export default {}",
					"server.js": "export default {}",
				},
			});
			const settle = (settlement = proof, callContext = context) =>
				settleAttemptProcedure["~orpc"].handler!({
					context: callContext,
					input: {
						id,
						attemptId: "native-attempt",
						outcome: "succeeded",
						settlement: WorkAttemptSettlementSchema.parse(settlement),
						complete: { expectedWorkItemVersion: 1 },
					},
					path: [],
					procedure: settleAttemptProcedure,
					signal: undefined,
					lastEventId: undefined,
				});
			await expect(settle({ ...proof, revision: 2 })).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
			await expect(
				settle({ ...proof, evidenceUri: "artifact://unrelated" }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			await expect(
				settle(proof, { ...context, organizationId: "other-org" }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			await expect(
				settle(proof, { ...context, externalAgentSessionId: "other-session" }),
			).rejects.toThrow();
			for (const [mutation, restore] of [
				[
					"UPDATE work_attempts SET expires_at='2000-01-01T00:00:00.000Z'",
					`UPDATE work_attempts SET expires_at='${new Date(Date.now() + 300000).toISOString()}'`,
				],
				[
					"INSERT INTO work_attempts(id,org_id,work_item_id,executor_type,executor_id,attempt_number,started_at,heartbeat_at,runtime_state,outcome) SELECT 'newer',org_id,work_item_id,executor_type,executor_id,2,started_at,heartbeat_at,'failed','failed' FROM work_attempts WHERE id='native-attempt'",
					"DELETE FROM work_attempts WHERE id='newer'",
				],
				[
					"UPDATE work_admissions SET work_item_version=2",
					"UPDATE work_admissions SET work_item_version=1",
				],
				[
					"UPDATE work_admissions SET decision='denied'",
					"UPDATE work_admissions SET decision='admitted'",
				],
				[
					"UPDATE work_items SET title='Send an email to the customer'",
					"UPDATE work_items SET title='Repair test failure'",
				],
				[
					"UPDATE work_items SET disposition='cancelled'",
					"UPDATE work_items SET disposition='accepted'",
				],
				[
					"UPDATE work_evidence SET attempt_id='older-attempt'",
					"UPDATE work_evidence SET attempt_id='native-attempt'",
				],
				[
					"UPDATE work_evidence SET org_id='other-org'",
					"UPDATE work_evidence SET org_id='org'",
				],
			]) {
				sqlite.exec(mutation);
				await expect(settle()).rejects.toThrow();
				sqlite.exec(restore);
			}
			if (mode === "native_sheet_revision") {
				native.output.mockResolvedValueOnce({
					status: "active",
					kind: "sheet",
					currentRevisionId: "newer",
				});
				await expect(settle()).rejects.toMatchObject({ code: "FORBIDDEN" });
				native.revision.mockResolvedValueOnce({
					outputId: artifactId,
					revision: 3,
					content: JSON.stringify({ kind: "sheet" }),
				});
				await expect(settle()).rejects.toMatchObject({ code: "FORBIDDEN" });
			} else {
				native.gadget.mockResolvedValueOnce({
					status: "removed",
					workspaceId,
					currentRevisionId: revisionId,
				});
				await expect(settle()).rejects.toMatchObject({ code: "FORBIDDEN" });
				native.code.mockResolvedValueOnce({
					revision: 3,
					files: { "client.js": "" },
				});
				await expect(settle()).rejects.toMatchObject({ code: "FORBIDDEN" });
			}
			expect(await getWorkItemById(db, id)).toMatchObject({
				disposition: "accepted",
				workKind: "coding",
				version: 1,
			});
			expect(
				await db.select({ outcome: workAttempts.outcome }).from(workAttempts),
			).toEqual([{ outcome: null }]);
			await expect(settle()).resolves.toMatchObject({
				workItem: { disposition: "completed", workKind: "coding", version: 2 },
				attempt: { outcome: "succeeded", metadata: { settlement: proof } },
			});
			await expect(settle()).resolves.toMatchObject({
				workItem: { disposition: "completed", version: 2 },
			});
			expect(
				(await db.select().from(workEvents)).filter(
					(x) => x.eventType === "work.completed",
				),
			).toHaveLength(1);
		},
	);
});

describe("owner-granted external-agent Work management", () => {
	it("grants org-wide edits without a source and revokes them immediately", async () => {
		const { sqlite, update, db, context, item } = await fixture();
		sqlite.exec("UPDATE work_items SET source_intent_id=NULL");
		const grant = {
			scope: "organization",
			actions: ["specification", "cancellation"],
		};
		sqlite
			.prepare("UPDATE external_agent_principals SET metadata=?")
			.run(JSON.stringify({ workManagement: grant }));
		await expect(
			update({ id, description: "Org-wide edit" }),
		).resolves.toBeDefined();
		const events = await db.select().from(workEvents);
		expect(events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					actorType: "external_agent",
					actorId: "bot",
				}),
			]),
		);
		await expect(
			workItemStewardActor(
				context,
				{ ...item, sourceIntentId: null },
				"cancellation",
			),
		).resolves.toMatchObject({ id: "bot" });
		await cancelFactoryWorkItemProcedure["~orpc"].handler!({
			context,
			input: { id, reason: "Owner-authorized cleanup" },
			path: [],
			procedure: cancelFactoryWorkItemProcedure,
			signal: undefined,
			lastEventId: undefined,
		});
		expect(await getWorkItemById(db, id)).toMatchObject({
			disposition: "cancelled",
		});
		expect(await db.select().from(workEvents)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					eventType: "work.cancelled",
					actorType: "external_agent",
					actorId: "bot",
				}),
			]),
		);
		sqlite.exec("UPDATE external_agent_principals SET metadata='{}'");
		await expect(update({ id, description: "Revoked" })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(
			workItemStewardActor(context, item, "cancellation"),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
	it("limits project grants to that project, including re-filing", async () => {
		const { sqlite, update } = await fixture();
		const projectId = "22222222-2222-4222-8222-222222222222";
		sqlite.prepare("UPDATE external_agent_principals SET metadata=?").run(
			JSON.stringify({
				workManagement: {
					scope: "project",
					projectId,
					actions: ["specification", "cancellation"],
				},
			}),
		);
		await expect(
			update({ id, description: "Outside project" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		sqlite
			.prepare("UPDATE work_items SET project_id=?, source_intent_id=NULL")
			.run(projectId);
		await expect(
			update({ id, description: "Inside project" }),
		).resolves.toBeDefined();
		await expect(
			update({ id, projectId: "33333333-3333-4333-8333-333333333333" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it.each([
		"failed",
		"expired",
		"succeeded",
		"aliased",
		"aliased wrong session",
		"other Work",
		"other org",
		"unadmitted",
		"wrong session",
		"missing Attempt",
		"missing settlement",
		"wrong commit",
	])(
		"checks recovered custody at settlement and completion: %s",
		async (state) => {
			const { db, sqlite, context } = await fixture();
			const now = Date.now();
			const sha = "a".repeat(40);
			const aliased = state.startsWith("aliased");
			const settlementSha = aliased ? "c".repeat(40) : sha;
			if (aliased)
				await db.insert(gitCommitAliases).values({
					oldSha: sha,
					newSha: settlementSha,
					repository: "example/repo",
				});
			const contract = { version: 1, doneLooksLike: "The fix is on main." };
			sqlite
				.prepare(
					"UPDATE work_items SET disposition='accepted', work_kind='coding', acceptance_contract=? WHERE id=?",
				)
				.run(JSON.stringify(contract), id);
			const base = {
				orgId: "org",
				workItemId: id,
				executorType: "external_agent" as const,
				executorId: "bot",
				executorSessionId: "session",
				externalSessionKey: "github-actions:example",
				heartbeatAt: new Date(now).toISOString(),
				expiresAt: new Date(now + 300000).toISOString(),
			};
			await db.insert(workAttempts).values({
				...base,
				id: "original",
				admissionId: state === "unadmitted" ? null : "original-admission",
				workItemId: state === "other Work" ? "other-work" : id,
				orgId: state === "other org" ? "other-org" : "org",
				executorId: "earlier-bot",
				executorSessionId: "earlier-session",
				externalSessionKey: "codex:earlier",
				attemptNumber: 1,
				runtimeState: "finished",
				outcome: ["failed", "expired"].includes(state)
					? (state as "failed" | "expired")
					: "succeeded",
				startedAt: new Date(now - 60000).toISOString(),
				finishedAt: new Date(now - 30000).toISOString(),
			});
			await db.insert(workAttempts).values({
				...base,
				id: "current",
				admissionId: "current-admission",
				attemptNumber: 2,
				startedAt: new Date(now).toISOString(),
				metadata: { dispatchVersion: 1 },
			});
			await db.insert(workAdmissions).values({
				id: "current-admission",
				orgId: base.orgId,
				workItemId: id,
				workItemVersion: 1,
				admissionSpecRevision:
					(await getWorkItemById(db, id))?.admissionSpecRevision ?? "",
				executorType: base.executorType,
				executorId: base.executorId,
				executorSessionId: base.executorSessionId,
				externalSessionKey: base.externalSessionKey,
				decision: "admitted",
				createdAt: base.heartbeatAt,
				decidedAt: base.heartbeatAt,
				expiresAt: base.expiresAt,
			});
			const metadata = {
				dispatchVersion: 1,
				laneResult: {
					outcome: "completed",
					workItemId: id,
					workVersion: 1,
					contractVersion: 1,
					outcomeText: contract.doneLooksLike,
				},
				recoveredCommits: [
					{
						commitSha: sha,
						attemptId: state === "missing Attempt" ? "missing" : "original",
						session: state.endsWith("wrong session")
							? "codex:unadmitted"
							: "codex:earlier",
					},
				],
			};
			const settle = (expectedWorkItemVersion = 1) =>
				settleAttemptProcedure["~orpc"].handler!({
					context,
					input: {
						id,
						attemptId: "current",
						outcome: "succeeded",
						complete: { expectedWorkItemVersion },
						metadata,
						...(state === "missing settlement"
							? {}
							: {
									settlement: {
										mode: "commit",
										commitShas: [
											state === "wrong commit" ? "b".repeat(40) : settlementSha,
										],
									},
								}),
					},
					path: [],
					procedure: settleAttemptProcedure,
					signal: undefined,
					lastEventId: undefined,
				});
			const complete = () =>
				completeProcedure["~orpc"].handler!({
					context,
					input: { id },
					path: [],
					procedure: completeProcedure,
					signal: undefined,
					lastEventId: undefined,
				});
			if (["failed", "expired", "succeeded", "aliased"].includes(state)) {
				await expect(settle(2)).rejects.toMatchObject({ code: "CONFLICT" });
				expect(await getWorkItemById(db, id)).toMatchObject({
					disposition: "accepted",
				});
				if (state === "failed") {
					sqlite.exec(`CREATE TRIGGER reject_completion_event BEFORE INSERT ON work_events
						WHEN NEW.event_type = 'work.completed'
						BEGIN SELECT RAISE(ABORT, 'test completion event failure'); END;`);
					await expect(settle()).rejects.toThrow();
					expect(await getWorkItemById(db, id)).toMatchObject({
						disposition: "accepted",
						version: 1,
					});
					expect(
						await db
							.select({ outcome: workAttempts.outcome })
							.from(workAttempts)
							.where(eq(workAttempts.id, "current")),
					).toEqual([{ outcome: null }]);
					sqlite.exec("DROP TRIGGER reject_completion_event");
				}
				const result = await settle();
				expect(result).toMatchObject({
					workItem: { disposition: "completed", version: 2 },
					attempt: { outcome: "succeeded", metadata: { closedWorkVersion: 1 } },
					settlement: { mode: "commit", commitShas: [settlementSha] },
				});
				await expect(settle()).resolves.toMatchObject({
					workItem: { disposition: "completed", version: 2 },
				});
				const events = await db
					.select({ eventType: workEvents.eventType })
					.from(workEvents)
					.where(eq(workEvents.workItemId, id))
					.orderBy(workEvents.sequence);
				expect(
					events.filter(({ eventType }) =>
						["attempt.settled", "work.completed"].includes(eventType),
					),
				).toEqual([
					{ eventType: "attempt.settled" },
					{ eventType: "work.completed" },
				]);
			} else {
				await expect(settle()).rejects.toMatchObject({ code: "FORBIDDEN" });
				// A retained or older server receipt must not bypass the completion check.
				await db
					.update(workAttempts)
					.set({
						runtimeState: "finished",
						outcome: "succeeded",
						finishedAt: new Date(now + 1).toISOString(),
						metadata,
					})
					.where(eq(workAttempts.id, "current"));
				await expect(complete()).rejects.toMatchObject({ code: "FORBIDDEN" });
				expect(await getWorkItemById(db, id)).toMatchObject({
					disposition: "accepted",
				});
			}
		},
	);
	it("refuses malformed recovery receipts before reading aliases", async () => {
		const { db, sqlite, context } = await fixture();
		const [attempt] = await db
			.insert(workAttempts)
			.values({
				id: "current",
				orgId: "org",
				workItemId: id,
				executorType: "external_agent",
				executorId: "bot",
				attemptNumber: 1,
				startedAt: new Date().toISOString(),
				heartbeatAt: new Date().toISOString(),
			})
			.returning();
		sqlite.exec("DROP TABLE git_commit_aliases");
		const row = {
			commitSha: "a".repeat(40),
			attemptId: "original",
			session: "codex:earlier",
		};
		const settlement = { mode: "commit", commitShas: [row.commitSha] };
		for (const recoveredCommits of [
			null,
			[],
			[null],
			[[]],
			["receipt"],
			[{ ...row, commitSha: "a".repeat(39) }],
			[{ ...row, commitSha: "g".repeat(40) }],
			[{ ...row, attemptId: null }],
			[{ ...row, session: null }],
			[row, { ...row, session: null }],
		])
			await expect(
				hasRecoveredCommitCustody(context, attempt!, {
					recoveredCommits,
					settlement,
				}),
			).resolves.toBe(false);
		await expect(
			hasRecoveredCommitCustody(context, attempt!, {
				recoveredCommits: [row],
				settlement: { mode: "commit", commitShas: [] },
			}),
		).resolves.toBe(false);
	});
	it("persists assignment and progress only inside the granted intent namespace", async () => {
		const { db, item, update, context } = await fixture();
		await update({
			id,
			executor: "codex",
			description: "Failure confirmed",
			expectedWorkItemVersion: item.version,
		});
		expect(await getWorkItemById(db, id)).toMatchObject({
			description: "Failure confirmed",
			executorType: "external_agent",
			executorId: "codex",
		});
		expect(
			await workItemStewardActor(context, item, "cancellation"),
		).toMatchObject({ type: "external_agent", id: "bot" });
	});
	it.each([
		{ prefixes: ["other:"] },
		{ prefixes: [""] },
		{ actions: ["cancellation"] },
		{ principalOrg: "other" },
		{ status: "retired" as const },
	])(
		"refuses an absent, malformed, unrelated or inactive grant: %j",
		async (options) => {
			const { update } = await fixture(options);
			await expect(
				update({ id, description: "Changed" }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		},
	);
	it("keeps assignment separate from ordinary edits and cannot lower risk", async () => {
		const { update } = await fixture({ actions: ["specification"] });
		await expect(
			update({ id, description: "Progress" }),
		).resolves.toBeDefined();
		await expect(update({ id, executor: "codex" })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(update({ id, riskLevel: "low" })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});
	it.each(["queued", "running", "waiting", "retrying"] as const)(
		"preserves %s Attempts and requires a verified session",
		async (runtimeState) => {
			const { db, update } = await fixture();
			await db.insert(workAttempts).values({
				id: "peer",
				orgId: "org",
				workItemId: id,
				executorType: "external_agent",
				executorId: "peer",
				runtimeState,
				attemptNumber: 1,
				startedAt: new Date().toISOString(),
				heartbeatAt: new Date().toISOString(),
			});
			await expect(
				update({ id, description: "Changed" }),
			).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
			session.mockResolvedValue(null);
			await expect(
				update({ id, description: "Changed" }),
			).rejects.toMatchObject({
				code: "UNAUTHORIZED",
			});
		},
	);
	it("does not grant completion or take authority from task metadata", async () => {
		const { sqlite, context, item, update } = await fixture();
		await expect(
			workItemStewardActor(context, item, "completion"),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		sqlite.exec("UPDATE external_agent_principals SET metadata='{}'");
		await expect(update({ id, description: "Changed" })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});
});
