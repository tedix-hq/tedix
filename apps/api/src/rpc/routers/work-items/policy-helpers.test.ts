import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { WorkItem } from "@tedix/db/schema/work-items";
import type { BaseContext } from "../../orpc";

const attempts = vi.hoisted(() => ({ list: vi.fn(), admission: vi.fn() }));
vi.mock("@tedix/db/queries/work-items/attempts", () => ({
	listWorkItemAttempts: attempts.list,
	getWorkAttemptRepositoryAdmission: attempts.admission,
	getRecordedWorkItemAttempt: vi.fn(),
}));

const artifact = vi.hoisted(() => ({
	evidence: vi.fn(),
	run: vi.fn(),
	skill: vi.fn(),
}));
vi.mock("@tedix/db/queries/work-items/evidence", () => ({
	getWorkItemEvidence: artifact.evidence,
}));
vi.mock("@tedix/db/queries/skill-runs", () => ({ getSkillRun: artifact.run }));
vi.mock("@tedix/db/queries/cognitive/skill-crud", () => ({
	getSkillEntry: artifact.skill,
}));

const delegation = vi.hoisted(() => ({ approver: vi.fn() }));
vi.mock(
	"@tedix/db/queries/work-items/delegated-approvals",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("@tedix/db/queries/work-items/delegated-approvals")
		>()),
		delegatedApprover: delegation.approver,
	}),
);
const tediLookup = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@tedix/db/queries/tedis", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/db/queries/tedis")>()),
	getTediById: tediLookup.get,
}));
const principal = vi.hoisted(() => ({ actor: vi.fn() }));
vi.mock("../work-items-principal", async (importOriginal) => ({
	...(await importOriginal<typeof import("../work-items-principal")>()),
	verifiedActiveWorkActor: principal.actor,
}));

const completion = vi.hoisted(() => ({ get: vi.fn(), complete: vi.fn() }));
vi.mock("@tedix/db/queries/work-items/crud", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/work-items/crud")
	>()),
	getWorkItemById: completion.get,
	completeWorkItem: completion.complete,
}));
vi.mock("../../../services/learning-interaction-recorder", () => ({
	recordObservedLearningInteraction: vi.fn(),
}));

import { completeProcedure } from "./factory-lifecycle";
import {
	canCompleteOwnSucceededAttempt,
	leadAgentCompletion,
	workItemStewardActor,
} from "./policy-helpers";

const AGENT = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const SHA = "a".repeat(40);
const DONE = "The accepted result is verified.";
const context = { db: {} } as unknown as BaseContext;

function item(overrides: Partial<WorkItem> = {}): WorkItem {
	return {
		id: "33333333-3333-4333-8333-333333333333",
		orgId: "44444444-4444-4444-8444-444444444444",
		disposition: "accepted",
		workKind: "coding",
		version: 1,
		admissionSpecRevision: "current-spec",
		title: "Fence the provider registration cache",
		description: "Keep stale loads from refilling scopes.",
		acceptanceContract: { version: 1, doneLooksLike: DONE },
		...overrides,
	} as WorkItem;
}

function attempt(overrides: Record<string, unknown> = {}) {
	return {
		executorType: "external_agent",
		executorId: AGENT,
		executorSessionId: SESSION,
		outcome: "succeeded",
		metadata: {
			dispatchVersion: 1,
			laneResult: {
				outcome: "completed",
				workItemId: "33333333-3333-4333-8333-333333333333",
				workVersion: 1,
				contractVersion: 1,
				outcomeText: DONE,
			},
			settlement: { mode: "commit", commitShas: [SHA] },
		},
		...overrides,
	};
}

describe("canCompleteOwnSucceededAttempt", () => {
	beforeEach(() => {
		attempts.list.mockReset();
		attempts.admission.mockReset();
		attempts.admission.mockResolvedValue({
			workItemVersion: 1,
			admissionSpecRevision: "current-spec",
		});
		attempts.list.mockResolvedValue({ data: [attempt()], nextCursor: null });
	});

	const allowed = (work = item(), sessionId: string | null = SESSION) =>
		canCompleteOwnSucceededAttempt(context, work, { id: AGENT, sessionId });

	it("rejects completion outside the caller's organization before resolving an actor", async () => {
		await expect(
			workItemStewardActor(
				{ ...context, organizationId: "other-organization" },
				item({ workKind: "operations" }),
				"completion",
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(attempts.list).not.toHaveBeenCalled();
	});

	it("lets the agent complete an accepted item its own succeeded settle proved with a commit", async () => {
		await expect(allowed()).resolves.toBe(true);
		expect(attempts.list).toHaveBeenCalledWith(context.db, {
			orgId: item().orgId,
			workItemId: item().id,
			limit: 1,
		});
	});

	it("allows a direct CLI coding settle against the current admission", async () => {
		const settlement = { mode: "commit", commitShas: [SHA] };
		const directAttempt = attempt({ metadata: { settlement } });
		attempts.list.mockResolvedValue({
			data: [directAttempt],
			nextCursor: null,
		});
		attempts.admission.mockResolvedValue({
			workItemVersion: 1,
			admissionSpecRevision: "current-spec",
		});
		await expect(allowed()).resolves.toBe(true);
		expect(attempts.admission).toHaveBeenCalledWith(context.db, directAttempt);
		await expect(allowed(item({ version: 2 }))).resolves.toBe(false);
		await expect(
			allowed(item({ admissionSpecRevision: "changed-spec" })),
		).resolves.toBe(false);
		await expect(allowed(item(), "other-session")).resolves.toBe(false);

		attempts.list.mockResolvedValue({
			data: [attempt({ metadata: { lane: true, settlement } })],
			nextCursor: null,
		});
		await expect(allowed()).resolves.toBe(false);
	});

	it.each([
		["another agent's attempt", { executorId: "other-agent" }],
		["another session of the same agent", { executorSessionId: "other" }],
		["a failed settle", { outcome: "failed" }],
		["a settle without a commit", { metadata: {} }],
		[
			"a malformed commit",
			{ metadata: { settlement: { mode: "commit", commitShas: ["abc"] } } },
		],
		["a tedi attempt", { executorType: "tedi" }],
		[
			"an earlier Work revision",
			{
				metadata: {
					dispatchVersion: 2,
					settlement: { mode: "commit", commitShas: [SHA] },
				},
			},
		],
	])("refuses %s", async (_label, overrides) => {
		attempts.list.mockResolvedValue({
			data: [attempt(overrides)],
			nextCursor: null,
		});
		await expect(allowed()).resolves.toBe(false);
	});

	it.each(["completed", "already_satisfied"])(
		"requires an exact %s declaration for a dispatcher Attempt",
		async (outcome) => {
			const work = item({
				version: 2,
				acceptanceContract: {
					version: 1,
					doneLooksLike: "The entire accepted result is verified.",
				},
			});
			attempts.admission.mockResolvedValue({
				workItemVersion: work.version,
				admissionSpecRevision: work.admissionSpecRevision,
			});
			const result = {
				outcome,
				workItemId: work.id,
				workVersion: 2,
				contractVersion: 1,
				outcomeText: work.acceptanceContract!.doneLooksLike,
			};
			for (const laneResult of [
				undefined,
				{ ...result, outcome: "incomplete" },
				{ ...result, workItemId: "other" },
				{ ...result, workVersion: 1 },
				{ ...result, contractVersion: 2 },
				{ ...result, outcomeText: "Only a subtask was done" },
			]) {
				attempts.list.mockResolvedValue({
					data: [
						attempt({
							metadata: {
								dispatchVersion: 2,
								laneResult,
								settlement: { mode: "commit", commitShas: [SHA] },
							},
						}),
					],
				});
				await expect(allowed(work)).resolves.toBe(false);
			}
			attempts.list.mockResolvedValue({
				data: [
					attempt({
						metadata: {
							dispatchVersion: 2,
							laneResult: result,
							settlement: { mode: "commit", commitShas: [SHA] },
						},
					}),
				],
			});
			await expect(allowed(work)).resolves.toBe(true);
		},
	);
	it("requires the configured organization skill result to belong to this Attempt", async () => {
		const proof = {
			mode: "skill_revision",
			skillId: "skill",
			skillRevision: 3,
			skillRunId: "run",
			evidenceId: AGENT,
			evidenceUri: "skill://runs/run",
		};
		const work = item({
			metadata: {
				artifactKind: proof.mode,
				artifactSkillId: proof.skillId,
				artifactSkillRevision: 3,
			},
		});
		const recorded = attempt();
		attempts.list.mockResolvedValue({
			data: [
				{
					...recorded,
					id: "current",
					metadata: { ...recorded.metadata, settlement: proof },
				},
			],
		});
		artifact.evidence.mockResolvedValue({
			attemptId: "other",
			kind: proof.mode,
			uri: proof.evidenceUri,
		});
		const verify = () =>
			canCompleteOwnSucceededAttempt(
				{ ...context, env: { ENVIRONMENT: "development" } } as BaseContext,
				work,
				{ id: AGENT, sessionId: SESSION },
			);
		await expect(verify()).resolves.toBe(false);
		artifact.evidence.mockResolvedValue({
			attemptId: "current",
			kind: proof.mode,
			uri: proof.evidenceUri,
		});
		artifact.run.mockResolvedValue({
			status: "completed",
			skillId: "skill",
			skillRevision: 3,
			workItemId: work.id,
		});
		artifact.skill.mockResolvedValue({
			lifecycleState: "active",
			tediId: null,
		});
		await expect(verify()).resolves.toBe(true);
	});

	it("refuses an item that is not accepted, or a caller without a session", async () => {
		await expect(allowed(item({ disposition: "proposed" }))).resolves.toBe(
			false,
		);
		await expect(allowed(item(), null)).resolves.toBe(false);
		attempts.list.mockResolvedValue({ data: [], nextCursor: null });
		await expect(allowed()).resolves.toBe(false);
	});

	it.each(["research", "operations", "document"] as const)(
		"requires a versioned declaration for its own succeeded %s without requiring a code commit",
		async (workKind) => {
			attempts.list.mockResolvedValue({
				data: [attempt({ metadata: {} })],
				nextCursor: null,
			});
			await expect(allowed(item({ workKind }))).resolves.toBe(false);
			attempts.list.mockResolvedValue({
				data: [attempt()],
				nextCursor: null,
			});
			await expect(allowed(item({ workKind }))).resolves.toBe(true);
			attempts.list.mockResolvedValue({
				data: [attempt({ executorSessionId: "other" })],
				nextCursor: null,
			});
			await expect(allowed(item({ workKind }))).resolves.toBe(false);
			await expect(
				allowed(item({ workKind, title: "Send a customer email" })),
			).resolves.toBe(false);
		},
	);

	it("uses the accepted verification outcome instead of credential incident history", async () => {
		const work = item({
			workKind: "operations",
			title: "Verify gateway session audit deployment",
			description:
				"Earlier incident: access tokens expired. Preserve existing grants and user consent. No new user sign-in needed for the token proof already collected.",
			acceptanceContract: {
				version: 1,
				doneLooksLike:
					"Observe managed delivery without changing release gates: verify the live API revision and audit results, and record evidence.",
			},
		});
		attempts.list.mockResolvedValue({
			data: [
				attempt({
					metadata: {
						dispatchVersion: work.version,
						laneResult: {
							outcome: "completed",
							workItemId: work.id,
							workVersion: work.version,
							contractVersion: work.acceptanceContract!.version,
							outcomeText: work.acceptanceContract!.doneLooksLike,
						},
					},
				}),
			],
			nextCursor: null,
		});
		await expect(allowed(work)).resolves.toBe(true);
	});

	it.each([
		{ executorId: "other-agent" },
		{ executorSessionId: "other-session" },
		{ outcome: "failed" },
		{ metadata: { dispatchVersion: 1 } },
	])(
		"retains attempt fences for non-coding verification: %j",
		async (overrides) => {
			attempts.list.mockResolvedValue({
				data: [attempt(overrides)],
				nextCursor: null,
			});
			await expect(allowed(item({ workKind: "operations" }))).resolves.toBe(
				false,
			);
		},
	);

	it.each([
		"Rotate the provider API key",
		"Pay the supplier invoice",
		"Send a customer email",
	])(
		"keeps accepted reserved actions owner-only: %s",
		async (doneLooksLike) => {
			attempts.list.mockResolvedValue({
				data: [attempt({ metadata: {} })],
				nextCursor: null,
			});
			await expect(
				allowed(
					item({
						workKind: "operations",
						title: "Verify provider recovery",
						description: "Read-only checks only.",
						acceptanceContract: { version: 1, doneLooksLike },
					}),
				),
			).resolves.toBe(false);
		},
	);

	it("retains reserved title and description checks when the outcome is harmless or empty", async () => {
		await expect(
			allowed(
				item({
					title: "Rotate the provider API key",
					acceptanceContract: {
						version: 1,
						doneLooksLike: "Record the result.",
					},
				}),
			),
		).resolves.toBe(false);
		await expect(
			allowed(
				item({
					description: "Pay the supplier invoice.",
					acceptanceContract: { version: 1, doneLooksLike: "  " },
				}),
			),
		).resolves.toBe(false);
	});

	it("does not turn a research prohibition into a reserved action", async () => {
		attempts.list.mockResolvedValue({
			data: [attempt()],
			nextCursor: null,
		});
		await expect(
			allowed(
				item({
					workKind: "research",
					title: "Verify recovery pickup",
					description:
						"Read the assigned Work and post a timestamped comment. No code edits, deployment, sign-in or consent.",
				}),
			),
		).resolves.toBe(true);
	});

	it.each([
		"Do not wait — rotate the provider API key",
		"No need to ask, send a customer email",
		"No credential changes. Pay the supplier invoice.",
		"Rotate the provider API key and paste the new credentials",
		"Pay the supplier invoice by bank transfer",
		"Send the weekly summary email to every customer",
	])("keeps owner completion for reserved work: %s", async (title) => {
		await expect(allowed(item({ title }))).resolves.toBe(false);
	});
});

describe("leadAgentCompletion", () => {
	const OWNER = "55555555-5555-4555-8555-555555555555";
	const ATTEMPT_ID = "66666666-6666-4666-8666-666666666666";
	const owned = (overrides: Partial<WorkItem> = {}) =>
		item({
			accountableOwnerType: "user",
			accountableOwnerId: OWNER,
			...overrides,
		});
	const lead = (
		work = owned(),
		id = AGENT,
		sessionId: string | null = SESSION,
	) => leadAgentCompletion(context, work, { id, sessionId });
	const settledAttempt = (overrides: Record<string, unknown> = {}) =>
		attempt({
			id: ATTEMPT_ID,
			runtimeState: "finished",
			executorId: "worker-agent",
			...overrides,
		});

	beforeEach(() => {
		delegation.approver.mockReset();
		tediLookup.get.mockReset();
		attempts.list.mockReset();
		attempts.admission.mockReset();
		attempts.admission.mockResolvedValue({
			workItemVersion: 1,
			admissionSpecRevision: "current-spec",
		});
		delegation.approver.mockResolvedValue({
			ownerId: OWNER,
			actorType: "external_agent",
			actorId: AGENT,
			actorName: "Lead agent",
			reason: "delegated",
		});
		attempts.list.mockResolvedValue({
			data: [settledAttempt()],
			nextCursor: null,
		});
	});

	it("lets the owner's configured lead agent complete verified landed Work", async () => {
		await expect(lead()).resolves.toEqual({
			onBehalfOf: { type: "user", id: OWNER },
			attemptId: ATTEMPT_ID,
		});
		expect(delegation.approver).toHaveBeenCalledWith(context.db, {
			orgId: owned().orgId,
			ownerId: OWNER,
			actor: { type: "external_agent", id: AGENT },
		});
	});

	it("accepts a landed_unverified settle with a commit", async () => {
		attempts.list.mockResolvedValue({
			data: [settledAttempt({ outcome: "landed_unverified" })],
			nextCursor: null,
		});
		await expect(lead()).resolves.toMatchObject({ attemptId: ATTEMPT_ID });
	});

	it("returns a delegated actor through workItemStewardActor", async () => {
		principal.actor.mockResolvedValue({
			type: "external_agent",
			id: AGENT,
			sessionId: SESSION,
			externalSessionKey: "lead:session",
		});
		const actor = await workItemStewardActor(
			{ ...context, organizationId: owned().orgId } as BaseContext,
			owned(),
			"completion",
		);
		expect(actor).toMatchObject({
			type: "external_agent",
			id: AGENT,
			delegatedCompletion: {
				onBehalfOf: { type: "user", id: OWNER },
				attemptId: ATTEMPT_ID,
			},
		});
	});

	it("resolves a tedi-owned item's delegation through its owning person", async () => {
		tediLookup.get.mockResolvedValue({
			organizationId: owned().orgId,
			status: "active",
			retiredAt: null,
			ownerUserId: OWNER,
		});
		await expect(
			lead(
				owned({ accountableOwnerType: "tedi", accountableOwnerId: "tedi-1" }),
			),
		).resolves.toMatchObject({ attemptId: ATTEMPT_ID });
		expect(delegation.approver).toHaveBeenCalledWith(
			context.db,
			expect.objectContaining({ ownerId: OWNER }),
		);
	});

	it.each([
		["not the configured lead", null],
		[
			"a failed settle",
			{ data: [settledAttempt({ outcome: "failed" })], nextCursor: null },
		],
		[
			"a running attempt",
			{
				data: [settledAttempt({ runtimeState: "running", outcome: null })],
				nextCursor: null,
			},
		],
		[
			"a landed_unverified settle without a commit",
			{
				data: [settledAttempt({ outcome: "landed_unverified", metadata: {} })],
				nextCursor: null,
			},
		],
	])("refuses %s", async (_label, list) => {
		if (list) attempts.list.mockResolvedValue(list);
		else delegation.approver.mockResolvedValue(null);
		await expect(lead()).resolves.toBeNull();
	});

	it.each(["coding", "research", "design", "operations"] as const)(
		"completes succeeded %s Work without a commit through the completion procedure",
		async (workKind) => {
			attempts.list.mockResolvedValue({
				data: [settledAttempt({ metadata: {} })],
				nextCursor: null,
			});
			principal.actor.mockResolvedValue({
				type: "external_agent",
				id: AGENT,
				sessionId: SESSION,
			});
			const work = owned({ workKind });
			completion.get.mockResolvedValue(work);
			completion.complete.mockResolvedValue({
				...work,
				disposition: "completed",
			});
			await expect(
				completeProcedure["~orpc"].handler!({
					input: { id: work.id },
					context: { ...context, organizationId: work.orgId },
					path: ["workItems", "complete"],
					procedure: completeProcedure,
					signal: undefined,
					lastEventId: undefined,
				}),
			).resolves.toMatchObject({ disposition: "completed" });
			expect(completion.complete).toHaveBeenLastCalledWith(
				context.db,
				expect.objectContaining({
					workItemId: work.id,
					expectedWorkItemVersion: work.version,
					actor: {
						type: "external_agent",
						id: AGENT,
						delegatedCompletion: {
							onBehalfOf: { type: "user", id: OWNER },
							attemptId: ATTEMPT_ID,
						},
						sessionId: SESSION,
					},
				}),
			);
			await expect(lead(owned({ version: 2 }))).resolves.toBeNull();
		},
	);

	it.each([
		"Rotate the provider API key",
		"Change billing settings",
		"Send a payment",
		"Send an email to the customer",
	])("keeps %s owner-only without a commit", async (title) => {
		attempts.list.mockResolvedValue({
			data: [settledAttempt({ metadata: {} })],
			nextCursor: null,
		});
		await expect(
			lead(
				owned({
					title,
					acceptanceContract: { version: 1, doneLooksLike: DONE },
				}),
			),
		).resolves.toBeNull();
		expect(delegation.approver).not.toHaveBeenCalled();
	});

	it("refuses unowned items", async () => {
		await expect(
			lead(
				owned({ accountableOwnerType: "system", accountableOwnerId: "ops" }),
			),
		).resolves.toBeNull();
		expect(delegation.approver).not.toHaveBeenCalled();
	});
});
