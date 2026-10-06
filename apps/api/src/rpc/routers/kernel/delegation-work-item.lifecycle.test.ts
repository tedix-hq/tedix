import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
	classifyDelegatedStop,
	declaredDelegationOutcome,
} from "./delegated-stop";
import type { BaseContext } from "../../orpc";

const mocks = vi.hoisted(() => ({
	addWorkItemCommentIfAbsent: vi.fn(async () => ({ inserted: true })),
	cancelWorkItem: vi.fn(),
	readChildRunResultAndLiveness: vi.fn(),
	findWorkItemsBlockedBy: vi.fn(),
	completeWorkItem: vi.fn(),
	getWorkItemById: vi.fn(),
	listWorkItemAttempts: vi.fn(),
	listWorkItemEvidence: vi.fn(),
	settleWorkItemAttempt: vi.fn(),
	submitWorkItemEvidence: vi.fn(),
}));

vi.mock("./child-run-reads", async (importOriginal) => ({
	...(await importOriginal<typeof import("./child-run-reads")>()),
	readChildRunResultAndLiveness: mocks.readChildRunResultAndLiveness,
}));
vi.mock("@tedix/db/queries/work-items/relations", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/work-items/relations")
	>()),
	findWorkItemsBlockedBy: mocks.findWorkItemsBlockedBy,
}));

vi.mock("@tedix/db/queries/work-items/attempts", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/work-items/attempts")
	>()),
	listWorkItemAttempts: mocks.listWorkItemAttempts,
	settleWorkItemAttempt: mocks.settleWorkItemAttempt,
}));
vi.mock("@tedix/db/queries/work-items/comments", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/work-items/comments")
	>()),
	addWorkItemCommentIfAbsent: mocks.addWorkItemCommentIfAbsent,
}));
vi.mock("@tedix/db/queries/work-items/crud", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/work-items/crud")
	>()),
	cancelWorkItem: mocks.cancelWorkItem,
	completeWorkItem: mocks.completeWorkItem,
	getWorkItemById: mocks.getWorkItemById,
}));
vi.mock("@tedix/db/queries/work-items/evidence", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/work-items/evidence")
	>()),
	listWorkItemEvidence: mocks.listWorkItemEvidence,
	submitWorkItemEvidence: mocks.submitWorkItemEvidence,
}));

import {
	type DelegationProofRefs,
	disposeDelegationWorkItem,
	disposeTerminalDirectDelegationWorkItem,
	extractDelegationProofRefs,
} from "./delegation-work-item";

describe("delegation terminal refusal proof", () => {
	it.each([
		"[assistant]\n🔴 Blocked fail-closed: `start_assigned_work` returned **403 FORBIDDEN** — “Delegated execution is limited to Work Items assigned to this tedi.”\n\nNo attempt was admitted, so I did not provision or use a workstation, run tests/export, submit evidence, or settle the Work Item. The required corroboration and canonical `exported_tests` receipt are therefore missing.",
		"[assistant]\n**Outcome: blocked** — execution was not admitted.",
		"[assistant]\n403 FORBIDDEN: the execution request was denied.",
	])(
		"rejects a terminal refusal without runtime telemetry: %s",
		(transcript) => {
			const proof = extractDelegationProofRefs({ metadata: {}, transcript });
			expect(proof.hasProof).toBe(false);
			expect(proof.evidenceState).toBe("missing");
		},
	);

	it("preserves successful answer-only explanations of forbidden responses", () => {
		const proof = extractDelegationProofRefs({
			metadata: {},
			transcript:
				"[assistant]\nA 403 Forbidden response means the caller lacks permission. The blocked request should be retried only after access is granted.",
		});
		expect(proof.hasProof).toBe(true);
		expect(proof.evidenceState).toBe("verified");
	});
});

const NOW = "2026-08-21T12:00:00.000Z";
const WORK_ITEM_ID = "11111111-1111-4111-8111-111111111111";
const ATTEMPT_ID = "22222222-2222-4222-8222-222222222222";
const EVIDENCE_ID = "33333333-3333-4333-8333-333333333333";

const wrapper = {
	id: WORK_ITEM_ID,
	orgId: "org-1",
	disposition: "accepted",
	acceptanceContract: {
		version: 1,
		doneLooksLike:
			"The delegated tedi settled its Attempt with a durable result reference.",
	},
	metadata: {
		source: "kernelRuntime.directDelegation",
		childRunId: "child-1",
		requiredProofKind: null,
	},
};

const activeAttempt = {
	id: ATTEMPT_ID,
	runId: "child-1",
	executorType: "tedi",
	executorId: "tedi-1",
	runtimeState: "running",
	outcome: null,
	metadata: {},
};

const proof: DelegationProofRefs = {
	hasProof: true,
	evidenceState: "verified",
	terminalExecutionSucceeded: false,
	repoCommitSha: null,
	prRef: null,
	artifactRefs: ["artifact://child-result"],
	rationaleRef: null,
	transcript: "Outcome: succeeded",
};

const pendingEvidence = {
	id: EVIDENCE_ID,
	attemptId: ATTEMPT_ID,
	claimKey: "delegation_result",
	kind: "artifact",
	uri: "artifact://child-result",
	digest: null,
	disposition: "pending",
	metadata: {},
};

function context(): BaseContext {
	return { db: {} } as BaseContext;
}

function dispose(proofOverride: DelegationProofRefs = proof) {
	return disposeDelegationWorkItem(context(), {
		childRunId: "child-1",
		childRunStatus: "completed",
		declaredOutcome: declaredDelegationOutcome(proofOverride.transcript),
		createdAt: NOW,
		delegatedTediId: "tedi-1",
		delegationError: null,
		organizationId: "org-1",
		proof: proofOverride,
		workItemId: WORK_ITEM_ID,
	});
}

beforeEach(() => {
	for (const mock of Object.values(mocks)) mock.mockReset();
	mocks.addWorkItemCommentIfAbsent.mockResolvedValue({ inserted: true });
	mocks.findWorkItemsBlockedBy.mockResolvedValue([]);
	mocks.getWorkItemById
		.mockResolvedValueOnce(wrapper)
		.mockResolvedValueOnce(wrapper);
	mocks.listWorkItemAttempts.mockResolvedValue({
		data: [activeAttempt],
		nextCursor: null,
	});
	mocks.listWorkItemEvidence.mockResolvedValue({ data: [], nextCursor: null });
	mocks.submitWorkItemEvidence.mockResolvedValue(pendingEvidence);
	mocks.completeWorkItem.mockResolvedValue({
		...wrapper,
		disposition: "completed",
	});
});

describe("Home delegation evidence lifecycle", () => {
	it.each(["failed", "canceled"] as const)(
		"settles canonical runtime %s even without an available final answer",
		async (status) => {
			mocks.readChildRunResultAndLiveness.mockResolvedValue({
				transcript: null,
				liveness: null,
				stopReason: null,
				stop: null,
				declaredOutcome: null,
				readAvailable: false,
			});
			const row = {
				id: "home-1",
				childRunId: "child-1",
				delegatedTediId: "tedi-1",
				organizationId: "org-1",
				metadata: { workItemId: WORK_ITEM_ID },
			} as Parameters<typeof disposeTerminalDirectDelegationWorkItem>[1]["row"];
			const result = await disposeTerminalDirectDelegationWorkItem(context(), {
				row,
				run: { status } as Parameters<
					typeof disposeTerminalDirectDelegationWorkItem
				>[1]["run"],
				createdAt: NOW,
				metadata: {},
				preview: "Provider failed before a final answer.",
			});
			const outcome = status === "canceled" ? "cancelled" : "failed";
			expect(result?.outcome).toBe(outcome);
			expect(mocks.settleWorkItemAttempt).toHaveBeenCalledWith(
				{},
				expect.objectContaining({
					attemptId: ATTEMPT_ID,
					executor: { type: "tedi", id: "tedi-1" },
					outcome,
				}),
			);
			expect(mocks.completeWorkItem).not.toHaveBeenCalled();
			expect(mocks.readChildRunResultAndLiveness).toHaveBeenCalledTimes(
				status === "canceled" ? 0 : 1,
			);
		},
	);

	it.each(["failed", "needs_follow_up", null] as const)(
		"does not settle when the authoritative result read is unavailable (prior %s)",
		async (priorOutcome) => {
			mocks.readChildRunResultAndLiveness.mockResolvedValue({
				transcript: null,
				liveness: null,
				stopReason: null,
				stop: null,
				declaredOutcome: null,
				readAvailable: false,
			});
			const row = {
				id: "home-1",
				childRunId: "child-1",
				delegatedTediId: "tedi-1",
				organizationId: "org-1",
				metadata: { workItemId: WORK_ITEM_ID },
			} as Parameters<typeof disposeTerminalDirectDelegationWorkItem>[1]["row"];
			await expect(
				disposeTerminalDirectDelegationWorkItem(context(), {
					row,
					run: { status: "completed" } as Parameters<
						typeof disposeTerminalDirectDelegationWorkItem
					>[1]["run"],
					createdAt: NOW,
					metadata: { childTaskOutcome: priorOutcome },
					preview: null,
				}),
			).rejects.toThrow("task outcome is unavailable");
			expect(mocks.settleWorkItemAttempt).not.toHaveBeenCalled();
			expect(mocks.completeWorkItem).not.toHaveBeenCalled();
		},
	);

	it.each([
		"Outcome: blocked\nExecution denied.",
		"Partial result: one part remains.",
		"[Turn stopped early: provider-call ceiling reached (10/10 steps)]",
	])("retains non-completion without depending on references: %s", (text) => {
		const stop = classifyDelegatedStop({
			assistantText: text,
			structuredStopReason: null,
		});
		return expect(
			disposeDelegationWorkItem(context(), {
				childRunId: "child-1",
				childRunStatus: "completed",
				childStop: stop,
				createdAt: NOW,
				delegatedTediId: "tedi-1",
				delegationError: null,
				organizationId: "org-1",
				proof: { ...proof, transcript: text },
				workItemId: WORK_ITEM_ID,
			}),
		).resolves.toMatchObject({
			outcome: "failed",
			workItemDisposition: "accepted",
		});
	});

	it.each(["failed", "canceled"] as const)(
		"runtime %s takes precedence over a success declaration",
		async (status) => {
			await expect(
				disposeDelegationWorkItem(context(), {
					childRunId: "child-1",
					childRunStatus: status,
					declaredOutcome: "succeeded",
					createdAt: NOW,
					delegatedTediId: "tedi-1",
					delegationError: "runtime failed",
					organizationId: "org-1",
					proof,
					workItemId: WORK_ITEM_ID,
				}),
			).resolves.toMatchObject({
				outcome: status === "canceled" ? "cancelled" : "failed",
			});
			expect(mocks.completeWorkItem).not.toHaveBeenCalled();
		},
	);

	it.each(["failed", "needs_follow_up"] as const)(
		"settles a declared %s without treating local refs as task success",
		async (declared) => {
			const final = `Outcome: ${declared}\n\nVerification gate failed; I did not push.\n\nVerification output:\nFAIL: parent changes must produce an actual config.ts merge conflict\n\nThe local final candidate is a two-parent merge commit, but the required verifier rejected its merge-tree conflict evidence:\nrepo_commit 11683b627600b6fe2e5cfce0468f0cc13afe0e58\n\nPublished commit: none — I did not publish.`;
			const refs = extractDelegationProofRefs({
				metadata: {},
				transcript: `[assistant]\n${final}\n[artifact:workstation_process/job/stderr.log]`,
			});
			mocks.readChildRunResultAndLiveness.mockResolvedValue({
				transcript: refs.transcript,
				liveness: null,
				stopReason: null,
				stop: null,
				declaredOutcome: declaredDelegationOutcome(final),
				readAvailable: true,
			});
			const row = {
				id: "home-1",
				childRunId: "child-1",
				delegatedTediId: "tedi-1",
				organizationId: "org-1",
				metadata: { workItemId: WORK_ITEM_ID },
			} as Parameters<typeof disposeTerminalDirectDelegationWorkItem>[1]["row"];
			const result = await disposeTerminalDirectDelegationWorkItem(context(), {
				row,
				run: { status: "completed" } as Parameters<
					typeof disposeTerminalDirectDelegationWorkItem
				>[1]["run"],
				createdAt: NOW,
				metadata: {},
				preview: final,
			});
			expect(result).toMatchObject({
				outcome: "failed",
				workItemDisposition: "accepted",
			});
			expect(mocks.settleWorkItemAttempt).toHaveBeenCalledOnce();
			expect(mocks.settleWorkItemAttempt).toHaveBeenCalledWith(
				{},
				expect.objectContaining({
					outcome: "failed",
					summary: expect.stringContaining("I did not push"),
					metadata: expect.objectContaining({
						declaredOutcome: declared,
						repoCommitSha: "11683b627600b6fe2e5cfce0468f0cc13afe0e58",
						artifactRefs: ["workstation_process/job/stderr.log"],
					}),
				}),
			);
			expect(mocks.completeWorkItem).not.toHaveBeenCalled();
			expect(mocks.submitWorkItemEvidence).not.toHaveBeenCalled();
		},
	);

	it("treats a success report without the required verification output as partial", async () => {
		await expect(
			disposeDelegationWorkItem(context(), {
				childRunId: "child-1",
				childRunStatus: "completed",
				childStop: {
					outcome: "partial",
					stopReason: "verification_missing",
					detail:
						"verification output missing (required: tedix -w tedix work approval-list)",
					steps: null,
					output: "Outcome: succeeded — fixed it.",
				},
				createdAt: NOW,
				delegatedTediId: "tedi-1",
				delegationError: null,
				organizationId: "org-1",
				proof,
				workItemId: WORK_ITEM_ID,
			}),
		).resolves.toMatchObject({
			outcome: "failed",
			workItemDisposition: "accepted",
			failureReason: "partial_result",
			retryable: true,
		});
		expect(mocks.completeWorkItem).not.toHaveBeenCalled();
		expect(mocks.settleWorkItemAttempt).toHaveBeenCalledWith(
			{},
			expect.objectContaining({
				outcome: "failed",
				summary: expect.stringContaining("verification output missing"),
			}),
		);
		expect(mocks.addWorkItemCommentIfAbsent).toHaveBeenCalledWith(
			{},
			expect.objectContaining({
				body: expect.stringContaining("verification output missing"),
			}),
		);
	});

	it("settles then completes without consulting the evidence plane", async () => {
		mocks.listWorkItemEvidence.mockRejectedValue(
			new Error("evidence read unavailable"),
		);
		mocks.submitWorkItemEvidence.mockRejectedValue(
			new Error("evidence write unavailable"),
		);
		await expect(dispose()).resolves.toMatchObject({
			outcome: "succeeded",
			workItemDisposition: "completed",
		});
		expect(mocks.listWorkItemEvidence).not.toHaveBeenCalled();
		expect(mocks.submitWorkItemEvidence).not.toHaveBeenCalled();
		expect(
			mocks.settleWorkItemAttempt.mock.invocationCallOrder[0],
		).toBeLessThan(mocks.completeWorkItem.mock.invocationCallOrder[0]!);
	});

	it.each(["settlement conflict", "STALE_ATTEMPT"])(
		"does not complete when fenced settlement rejects: %s",
		async (error) => {
			mocks.settleWorkItemAttempt.mockRejectedValue(new Error(error));
			await expect(dispose()).rejects.toThrow(error);
			expect(mocks.completeWorkItem).not.toHaveBeenCalled();
		},
	);

	it("completes idempotently from the exact settled Attempt without evidence", async () => {
		mocks.listWorkItemAttempts.mockResolvedValue({
			data: [
				{ ...activeAttempt, runtimeState: "finished", outcome: "succeeded" },
			],
			nextCursor: null,
		});
		mocks.listWorkItemEvidence.mockRejectedValue(
			new Error("evidence unavailable"),
		);
		await expect(dispose()).resolves.toMatchObject({
			outcome: "succeeded",
			workItemDisposition: "completed",
		});
		expect(mocks.settleWorkItemAttempt).not.toHaveBeenCalled();
		expect(mocks.listWorkItemEvidence).not.toHaveBeenCalled();
		expect(mocks.completeWorkItem).toHaveBeenCalledOnce();
	});

	it("does not repeat settlement or completion after reconciliation converges", async () => {
		mocks.listWorkItemAttempts.mockResolvedValue({
			data: [
				{ ...activeAttempt, runtimeState: "finished", outcome: "succeeded" },
			],
			nextCursor: null,
		});
		mocks.getWorkItemById.mockReset();
		mocks.getWorkItemById.mockResolvedValue({
			...wrapper,
			disposition: "completed",
		});
		await expect(dispose()).resolves.toMatchObject({
			outcome: "succeeded",
			workItemDisposition: "completed",
		});
		expect(mocks.settleWorkItemAttempt).not.toHaveBeenCalled();
		expect(mocks.completeWorkItem).not.toHaveBeenCalled();
	});

	it("rejects a settled attempt owned by a different executor", async () => {
		mocks.listWorkItemAttempts.mockResolvedValue({
			data: [
				{
					...activeAttempt,
					executorId: "different-tedi",
					runtimeState: "finished",
					outcome: "succeeded",
				},
			],
			nextCursor: null,
		});

		await expect(dispose()).rejects.toThrow(
			"exact active or previously succeeded attempt fence",
		);
		expect(mocks.listWorkItemEvidence).not.toHaveBeenCalled();
		expect(mocks.completeWorkItem).not.toHaveBeenCalled();
	});

	it.each(["code", "terminal_execution"])(
		"keeps %s references as metadata rather than completion prerequisites",
		async (requiredProofKind) => {
			mocks.getWorkItemById.mockReset();
			mocks.getWorkItemById.mockResolvedValue({
				...wrapper,
				metadata: { ...wrapper.metadata, requiredProofKind },
			});
			await expect(
				dispose({
					...proof,
					repoCommitSha: null,
					terminalExecutionSucceeded: false,
					artifactRefs: [],
				}),
			).resolves.toMatchObject({
				outcome: "succeeded",
				workItemDisposition: "completed",
			});
		},
	);

	it("does not auto-complete a reused canonical Work Item", async () => {
		mocks.getWorkItemById.mockReset();
		mocks.getWorkItemById.mockResolvedValue({
			...wrapper,
			metadata: { source: "user.created" },
		});

		await expect(dispose()).resolves.toMatchObject({
			outcome: "succeeded",
			workItemDisposition: "accepted",
		});
		expect(mocks.settleWorkItemAttempt).toHaveBeenCalledOnce();
		expect(mocks.submitWorkItemEvidence).not.toHaveBeenCalled();
		expect(mocks.completeWorkItem).not.toHaveBeenCalled();
	});

	it("returns a canceled canonical reuse to accepted from the attempt marker", async () => {
		mocks.getWorkItemById.mockReset();
		mocks.getWorkItemById.mockResolvedValue({
			...wrapper,
			metadata: { source: "user.created" },
		});
		mocks.listWorkItemAttempts.mockResolvedValue({
			data: [
				{
					...activeAttempt,
					metadata: { canonicalWorkItemReuse: true },
				},
			],
			nextCursor: null,
		});

		await expect(
			disposeDelegationWorkItem(context(), {
				childRunId: "child-1",
				childRunStatus: "canceled",
				createdAt: NOW,
				delegatedTediId: "tedi-1",
				delegationError: null,
				organizationId: "org-1",
				proof,
				workItemId: WORK_ITEM_ID,
			}),
		).resolves.toMatchObject({
			outcome: "cancelled",
			workItemDisposition: "accepted",
			failureReason: null,
			retryable: true,
		});
		expect(mocks.cancelWorkItem).not.toHaveBeenCalled();
		expect(mocks.settleWorkItemAttempt).toHaveBeenCalledWith(
			{},
			expect.objectContaining({ outcome: "cancelled" }),
		);
	});

	it.each(["missing", "unknown"] as const)(
		"does not make %s proof a completion prerequisite",
		async (evidenceState) => {
			await expect(
				dispose({
					...proof,
					hasProof: false,
					evidenceState,
					artifactRefs: [],
					transcript: "Outcome: succeeded\nThe requested answer is ready.",
				}),
			).resolves.toMatchObject({
				outcome: "succeeded",
				workItemDisposition: "completed",
				failureReason: null,
			});
			expect(mocks.submitWorkItemEvidence).not.toHaveBeenCalled();
			expect(mocks.settleWorkItemAttempt).toHaveBeenCalledWith(
				{},
				expect.objectContaining({ outcome: "succeeded" }),
			);
			expect(mocks.completeWorkItem).toHaveBeenCalledOnce();
		},
	);

	it("retains terminal execution telemetry in the settled Attempt", async () => {
		const terminalWrapper = {
			...wrapper,
			metadata: {
				...wrapper.metadata,
				requiredProofKind: "terminal_execution",
			},
		};
		mocks.getWorkItemById.mockReset();
		mocks.getWorkItemById
			.mockResolvedValueOnce(terminalWrapper)
			.mockResolvedValueOnce(terminalWrapper);

		await dispose({
			...proof,
			terminalExecutionSucceeded: true,
			artifactRefs: [],
		});
		expect(mocks.settleWorkItemAttempt).toHaveBeenCalledWith(
			{},
			expect.objectContaining({
				metadata: expect.objectContaining({
					terminalExecutionSucceeded: true,
					proof: "child-run:child-1",
				}),
			}),
		);
		expect(mocks.submitWorkItemEvidence).not.toHaveBeenCalled();
	});
});
