import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { KernelRuntimeRun } from "@tedix/db/queries/kernel-runtime-runs";
import type { KernelRuntimeEvent } from "@tedix/db/queries/kernel-runtime-events";
import type { BaseContext } from "../../orpc";
import {
	recordedDelegationApprovalScope,
	resumeRecordedHomeDelegationApproval,
} from "./delegation-approval-resume";

const effects = vi.hoisted(() => ({
	events: vi.fn(),
	work: vi.fn(),
	readiness: vi.fn(),
	claim: vi.fn(),
	dispatch: vi.fn(),
}));
vi.mock("@tedix/db/queries/kernel-runtime-events", () => ({
	listKernelRuntimeEvents: effects.events,
}));
vi.mock("@tedix/db/queries/kernel-runtime-runs", () => ({
	claimApprovedHomeDelegationResume: effects.claim,
}));
vi.mock("@tedix/db/queries/work-items/crud", () => ({
	getWorkItemById: effects.work,
}));
vi.mock("@tedix/db/queries/work-items/readiness", () => ({
	deriveWorkItemReadiness: effects.readiness,
}));
vi.mock("./approval-control", () => ({
	respondKernelDelegationRecommendationApprovalCore: effects.dispatch,
}));

const AT = "2026-01-01T00:00:00.000Z";
function fixture() {
	const workOrder = {
		targetTediId: "fictional-tedi",
		status: "draft",
		kind: "workstation.attach",
		sourceContent: "Review the selected fictional Work",
		budget: { maxToolCalls: 20 },
		executionRequirement: {
			surface: "workstation",
			requiredCapabilities: [],
			prohibitedSurfaces: [],
			fallbackSurface: null,
			satisfiable: true,
			reason: "operator selected",
		},
	};
	const run = {
		id: "fictional-run",
		organizationId: "fictional-org",
		conversationId: "fictional-conversation",
		status: "requires_approval",
		updatedAt: AT,
		latestEventAt: AT,
		childRunId: null,
		delegatedTediId: null,
		childConversationId: null,
		runtimeMetadata: null,
		metadata: {
			redriveInput: { runtimeMetadata: { workItemId: "fictional-work" } },
			homeDelegation: {
				decision: {
					mode: "needs_approval",
					reason: "human-reserved: credentials",
				},
				workOrder,
				expiresAt: "2099-01-01T00:00:00.000Z",
			},
		},
	} as unknown as KernelRuntimeRun;
	const event = {
		id: [
			"home",
			run.organizationId,
			"event",
			"delegation.approval.resolved",
			run.conversationId,
			run.id,
			AT,
		].join(":"),
		organizationId: run.organizationId,
		conversationId: run.conversationId,
		runId: run.id,
		createdAt: AT,
		kind: "approval.resolved",
		delegatedTediId: "fictional-tedi",
		payload: {
			status: "approved",
			resolvedBy: null,
			resolution: null,
			delegationWorkOrder: { ...workOrder, status: "approved" },
		},
		runtimeMetadata: {
			source: "kernelRuntime.respondApproval",
			dispatch: "home-delegation-approved",
		},
	} as unknown as KernelRuntimeEvent;
	const input = {
		runId: run.id,
		resumeOnly: true as const,
		approvalEventId: event.id,
		expectedWorkItemVersion: 2,
	};
	return { run, event, input, context: { db: {} } as BaseContext };
}
function noMutation() {
	expect(effects.claim).not.toHaveBeenCalled();
	expect(effects.dispatch).not.toHaveBeenCalled();
}

beforeEach(() => {
	vi.clearAllMocks();
	effects.work.mockResolvedValue({
		id: "fictional-work",
		orgId: "fictional-org",
		version: 2,
		disposition: "accepted",
		admissionSpecRevision: "fictional-spec",
	});
	effects.readiness.mockResolvedValue({ ready: true, state: "ready" });
	effects.dispatch.mockResolvedValue({
		run: { id: "fictional-run" },
		assignments: [],
	});
	effects.claim.mockImplementation(async (_db, input) => ({
		...fixture().run,
		updatedAt: input.now,
		metadata: {
			...fixture().run.metadata,
			homeDelegationResume: {
				claimId: input.claimId,
				approvalEventId: input.approvalEventId,
				approvalResolvedAt: input.approvalResolvedAt,
				phase: "claimed",
				workItemId: input.workItemId,
			},
		},
	}));
});

describe("recorded operator delegation approval continuation", () => {
	it("continues the canonical unchanged receipt without inventing an actor or new decision", async () => {
		const f = fixture();
		effects.events.mockResolvedValue([f.event]);
		await resumeRecordedHomeDelegationApproval(f.context, f.input, f.run);
		expect(effects.claim).toHaveBeenCalledExactlyOnceWith(
			expect.anything(),
			expect.objectContaining({
				expectedUpdatedAt: AT,
				approvalEventId: f.event.id,
				approvalResolvedAt: AT,
				workItemId: "fictional-work",
				workItemVersion: 2,
				scopeDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
			}),
		);
		expect(effects.dispatch).toHaveBeenCalledExactlyOnceWith(
			f.context,
			expect.objectContaining({
				approvedWorkItemId: "fictional-work",
				recordedApproval: expect.objectContaining({
					eventId: f.event.id,
					resolvedAt: AT,
					resolvedBy: null,
					resolution: null,
				}),
			}),
		);
		expect(effects.dispatch.mock.calls[0]![1].resolvedBy).toBeUndefined();
		expect(f.event.payload).toMatchObject({
			resolvedBy: null,
			status: "approved",
		});
	});
	it.each([{ events: [] }, { events: [fixture().event, fixture().event] }])(
		"refuses absent or ambiguous decisions",
		async ({ events }) => {
			const f = fixture();
			effects.events.mockResolvedValue(events);
			await expect(
				resumeRecordedHomeDelegationApproval(f.context, f.input, f.run),
			).rejects.toThrow(/absent|ambiguous/);
			noMutation();
			expect(effects.readiness).not.toHaveBeenCalled();
		},
	);
	it.each(["organizationId", "runId", "conversationId", "delegatedTediId"])(
		"refuses another receipt %s",
		async (field) => {
			const f = fixture();
			Object.assign(f.event, { [field]: "foreign" });
			effects.events.mockResolvedValue([f.event]);
			await expect(
				resumeRecordedHomeDelegationApproval(f.context, f.input, f.run),
			).rejects.toThrow(/another delegation/);
			noMutation();
		},
	);
	it.each(["sourceContent", "budget", "executionRequirement"])(
		"refuses changed approved scope %s",
		async (field) => {
			const f = fixture();
			const wo = (f.event.payload as Record<string, unknown>)
				.delegationWorkOrder as Record<string, unknown>;
			wo[field] =
				field === "sourceContent" ? "Different work" : { changed: true };
			effects.events.mockResolvedValue([f.event]);
			await expect(
				resumeRecordedHomeDelegationApproval(f.context, f.input, f.run),
			).rejects.toThrow(/work order changed/);
			noMutation();
		},
	);
	it("refuses a policy-created event even if its work order says approved", () => {
		const f = fixture();
		(f.event.payload as Record<string, unknown>).resolvedBy = {
			type: "policy",
			id: "fictional-policy",
		};
		expect(() =>
			recordedDelegationApprovalScope(f.run, f.event, new Date().toISOString()),
		).toThrow(/operator decision/);
	});
	it("refuses an expired approval", () => {
		const f = fixture();
		(f.run.metadata!.homeDelegation as Record<string, unknown>).expiresAt =
			"2000-01-01T00:00:00.000Z";
		expect(() =>
			recordedDelegationApprovalScope(f.run, f.event, new Date().toISOString()),
		).toThrow(/expired/);
	});
	it("refuses conflicting saved Work bindings", () => {
		const f = fixture();
		f.run.metadata!.workItemId = "foreign-work";
		expect(() =>
			recordedDelegationApprovalScope(f.run, f.event, new Date().toISOString()),
		).toThrow(/ambiguous/);
	});
	it.each(["canceled", "completed", "failed"])(
		"does not revive a %s parent",
		async (status) => {
			const f = fixture();
			f.run.status = status as KernelRuntimeRun["status"];
			effects.events.mockResolvedValue([f.event]);
			await expect(
				resumeRecordedHomeDelegationApproval(f.context, f.input, f.run),
			).rejects.toThrow(/run changed/);
			noMutation();
		},
	);
	it("refuses a changed current Work version", async () => {
		const f = fixture();
		effects.events.mockResolvedValue([f.event]);
		effects.work.mockResolvedValue({
			id: "fictional-work",
			orgId: "fictional-org",
			version: 3,
			disposition: "accepted",
		});
		await expect(
			resumeRecordedHomeDelegationApproval(f.context, f.input, f.run),
		).rejects.toThrow(/Work version/);
		noMutation();
	});
	it("rechecks admission rather than treating the operator receipt as a Work risk approval", async () => {
		const f = fixture();
		effects.events.mockResolvedValue([f.event]);
		effects.readiness.mockResolvedValue({
			ready: false,
			state: "missing_approval",
		});
		await expect(
			resumeRecordedHomeDelegationApproval(f.context, f.input, f.run),
		).rejects.toThrow(/admission is blocked/);
		noMutation();
	});
	it("does not dispatch after a lost claim", async () => {
		const f = fixture();
		effects.events.mockResolvedValue([f.event]);
		effects.claim.mockResolvedValue(null);
		await expect(
			resumeRecordedHomeDelegationApproval(f.context, f.input, f.run),
		).rejects.toThrow(/won the continuation claim/);
		expect(effects.dispatch).not.toHaveBeenCalled();
	});
	it("does not retry a prepared claim with unknown effects", async () => {
		const f = fixture();
		f.run.metadata!.homeDelegationResume = {
			approvalEventId: f.event.id,
			workItemId: "fictional-work",
			workItemVersion: 2,
			phase: "dispatching",
		};
		effects.events.mockResolvedValue([f.event]);
		await expect(
			resumeRecordedHomeDelegationApproval(f.context, f.input, f.run),
		).rejects.toThrow(/may already have effects/);
		noMutation();
	});
	it.each([
		{ canceled: false, late: false },
		{ canceled: true, late: false },
		{ canceled: false, late: true },
		{ canceled: true, late: true },
	])(
		"returns an acknowledged child receipt without another send %j",
		async ({ canceled, late }) => {
			const f = fixture();
			effects.events.mockResolvedValue([f.event]);
			await resumeRecordedHomeDelegationApproval(f.context, f.input, f.run);
			const prepared = effects.claim.mock.calls[0]![1];
			effects.claim.mockClear();
			effects.dispatch.mockClear();
			effects.readiness.mockClear();
			f.run.status = canceled ? "canceled" : "queued";
			f.run.updatedAt = new Date().toISOString();
			f.run.childRunId = canceled ? null : prepared.expectedChildRunId;
			f.run.delegatedTediId = canceled ? null : "fictional-tedi";
			f.run.metadata!.homeDelegationResume = {
				approvalEventId: f.event.id,
				workItemId: "fictional-work",
				workItemVersion: 2,
				phase: "observed",
				scopeDigest: prepared.scopeDigest,
				expectedChildRunId: prepared.expectedChildRunId,
				observation: {
					outcome: "acknowledged",
					observedChildRunId: prepared.expectedChildRunId,
				},
			};
			if (late) {
				const marker = f.run.metadata!.homeDelegationResume as Record<
					string,
					unknown
				>;
				marker.lateObservation = marker.observation;
				marker.observation = { outcome: "unknown", observedChildRunId: null };
			}
			const result = await resumeRecordedHomeDelegationApproval(
				f.context,
				f.input,
				f.run,
			);
			expect(result.run.childRunId).toBe(
				canceled ? null : prepared.expectedChildRunId,
			);
			expect(result.run.status).toBe(canceled ? "canceled" : "queued");
			expect(result.run.metadata?.homeDelegationResume).toMatchObject({
				[late ? "lateObservation" : "observation"]: {
					observedChildRunId: prepared.expectedChildRunId,
					outcome: "acknowledged",
				},
			});
			noMutation();
			expect(effects.readiness).not.toHaveBeenCalled();
		},
	);
	it.each(["source", "dispatch"])(
		"refuses an event from another producer %s",
		async (field) => {
			const f = fixture();
			(f.event.runtimeMetadata as Record<string, unknown>)[field] = "untrusted";
			effects.events.mockResolvedValue([f.event]);
			await expect(
				resumeRecordedHomeDelegationApproval(f.context, f.input, f.run),
			).rejects.toThrow(/operator delegation/);
			noMutation();
		},
	);
	it("refuses a rejected receipt", async () => {
		const f = fixture();
		(f.event.payload as Record<string, unknown>).status = "rejected";
		effects.events.mockResolvedValue([f.event]);
		await expect(
			resumeRecordedHomeDelegationApproval(f.context, f.input, f.run),
		).rejects.toThrow(/operator delegation/);
		noMutation();
	});
	it("refuses a superseded run latch", async () => {
		const f = fixture();
		f.run.updatedAt = "2026-01-01T00:00:01.000Z";
		effects.events.mockResolvedValue([f.event]);
		await expect(
			resumeRecordedHomeDelegationApproval(f.context, f.input, f.run),
		).rejects.toThrow(/run changed/);
		noMutation();
	});
});
