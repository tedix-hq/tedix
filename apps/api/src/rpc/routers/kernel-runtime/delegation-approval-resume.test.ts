import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { KernelRuntimeRun } from "@tedix/db/queries/kernel-runtime-runs";
import type { KernelRuntimeEvent } from "@tedix/db/queries/kernel-runtime-events";
import type { BaseContext } from "../../orpc";
import {
	delegationApprovalEventSetDigest,
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
		runtimeBackend: "custom",
		runtimeExternalId: null,
		runtimeExternalUrl: null,
		childRunId: null,
		causeEventId: null,
		messageId: null,
		sequence: null,
		delta: null,
		traceId: "fictional-private-trace",
	} as unknown as KernelRuntimeEvent;
	const input = {
		runId: run.id,
		resumeOnly: true as const,
		approvalEventId: event.id,
		expectedWorkItemVersion: 2,
	};
	return { run, event, input, context: { db: {} } as BaseContext };
}
async function eventSetFixture(count = 2) {
	const f = fixture();
	const events = Array.from({ length: count }, (_, i) => {
		const createdAt = new Date(Date.parse(AT) + i * 1000).toISOString();
		return {
			...structuredClone(f.event),
			createdAt,
			id: f.event.id.replace(AT, createdAt),
		};
	});
	const latest = events.at(-1)!;
	f.run.updatedAt = latest.createdAt;
	f.run.latestEventAt = latest.createdAt;
	const originalExpiresAt = "2099-01-01T00:00:00.000Z";
	return {
		...f,
		events,
		originalExpiresAt,
		input: {
			...f.input,
			approvalEventId: latest.id,
			approvalEventSet: {
				eventIds: events.map((event) => event.id),
				digest: await delegationApprovalEventSetDigest({
					events,
					originalExpiresAt,
				}),
			},
		},
	};
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
	it.each([2, 4, 8])(
		"continues an explicit complete unchanged set of %i approvals once",
		async (count) => {
			const f = await eventSetFixture(count);
			effects.events.mockResolvedValue([...f.events].reverse());
			await resumeRecordedHomeDelegationApproval(f.context, f.input, f.run);
			expect(effects.events).toHaveBeenCalledWith(
				f.context.db,
				expect.objectContaining({ limit: 9, kind: "approval.resolved" }),
			);
			expect(effects.claim).toHaveBeenCalledExactlyOnceWith(
				f.context.db,
				expect.objectContaining({
					approvalEventId: f.input.approvalEventId,
					approvalEventSet: {
						digest: f.input.approvalEventSet.digest,
						originalExpiresAt: f.originalExpiresAt,
						events: f.events,
					},
				}),
			);
			expect(effects.dispatch).toHaveBeenCalledTimes(1);
			expect(
				effects.dispatch.mock.calls[0]![1].recordedApproval.resolvedBy,
			).toBeNull();
		},
	);
	it.each([
		"overflow",
		"subset",
		"reordered",
		"duplicate",
		"latest",
		"digest",
		"expiry",
		"expired",
		"payload",
		"producer",
		"actor",
		"identity",
		"foreign",
	])("refuses an unsafe explicit set: %s", async (change) => {
		const f = await eventSetFixture(change === "overflow" ? 9 : 2);
		if (change === "subset") f.input.approvalEventSet.eventIds.pop();
		if (change === "reordered") f.input.approvalEventSet.eventIds.reverse();
		if (change === "duplicate")
			f.input.approvalEventSet.eventIds[0] = f.input.approvalEventId;
		if (change === "latest") f.input.approvalEventId = f.events[0]!.id;
		if (change === "digest") f.input.approvalEventSet.digest = "0".repeat(64);
		if (change === "expiry" || change === "expired")
			(f.run.metadata!.homeDelegation as Record<string, unknown>).expiresAt =
				change === "expiry" ? "2098-01-01T00:00:00.000Z" : AT;
		if (change === "payload")
			f.events[0]!.payload = {
				...f.events[0]!.payload,
				resolution: "changed note",
			};
		if (change === "producer")
			f.events[0]!.runtimeMetadata = { source: "untrusted" };
		if (change === "actor")
			f.events[0]!.payload = {
				...f.events[0]!.payload,
				resolvedBy: { type: "policy", id: "fictional" },
			};
		if (change === "identity") f.events[0]!.id = "noncanonical";
		if (change === "foreign") f.events[0]!.organizationId = "foreign";
		effects.events.mockResolvedValue([...f.events].reverse());
		await expect(
			resumeRecordedHomeDelegationApproval(f.context, f.input, f.run),
		).rejects.toThrow(/Recorded approval cannot continue/);
		noMutation();
		expect(effects.readiness).not.toHaveBeenCalled();
	});
	it("retains the default unique-event refusal for identical approvals", async () => {
		const f = await eventSetFixture();
		effects.events.mockResolvedValue([...f.events].reverse());
		const { approvalEventSet: _set, ...input } = f.input;
		await expect(
			resumeRecordedHomeDelegationApproval(f.context, input, f.run),
		).rejects.toThrow(/ambiguous/);
		noMutation();
		expect(effects.events).toHaveBeenCalledWith(
			f.context.db,
			expect.objectContaining({ limit: 2 }),
		);
	});
	it("round-trips the actual public replay into a usable digest without hidden fields", async () => {
		const f = await eventSetFixture();
		const { kernelStreamRow, buildRunEventStreamPage } =
			await import("./run-reads-streams");
		const page = buildRunEventStreamPage(f.events.map(kernelStreamRow), {
			runId: f.run.id,
		});
		const wire = JSON.parse(JSON.stringify(page)) as typeof page;
		expect(wire.events[0]).not.toHaveProperty("runtimeMetadata");
		expect(wire.events[0]).not.toHaveProperty("traceId");
		expect(wire.events[0]).not.toHaveProperty("messageId");
		expect(wire.events[0]!.payload).toMatchObject({ resolvedBy: null });
		f.input.approvalEventSet.digest = await delegationApprovalEventSetDigest({
			events: wire.events,
			originalExpiresAt: f.originalExpiresAt,
		});
		effects.events.mockResolvedValue([...f.events].reverse());
		await resumeRecordedHomeDelegationApproval(f.context, f.input, f.run);
		expect(effects.dispatch).toHaveBeenCalledTimes(1);
		expect(effects.claim.mock.calls[0]![1].approvalEventSet.events).toEqual(
			f.events,
		);
	});
	it("keeps hidden provenance out of the public digest while still refusing an untrusted producer", async () => {
		const f = await eventSetFixture();
		f.events[0]!.runtimeMetadata = { source: "untrusted" };
		f.events[0]!.traceId = "changed-hidden-trace";
		expect(
			await delegationApprovalEventSetDigest({
				events: f.events,
				originalExpiresAt: f.originalExpiresAt,
			}),
		).toBe(f.input.approvalEventSet.digest);
		effects.events.mockResolvedValue([...f.events].reverse());
		await expect(
			resumeRecordedHomeDelegationApproval(f.context, f.input, f.run),
		).rejects.toThrow(/operator delegation/);
		noMutation();
	});
	it("refuses an oversized full proof before claiming even when its digest matches", async () => {
		const f = await eventSetFixture();
		f.events[0]!.runtimeMetadata = {
			...f.events[0]!.runtimeMetadata,
			retained: "x".repeat(256 * 1024),
		};
		f.input.approvalEventSet.digest = await delegationApprovalEventSetDigest({
			events: f.events,
			originalExpiresAt: f.originalExpiresAt,
		});
		effects.events.mockResolvedValue([...f.events].reverse());
		await expect(
			resumeRecordedHomeDelegationApproval(f.context, f.input, f.run),
		).rejects.toThrow(/proof limit/);
		noMutation();
	});
	it.each(["same", "digest", "expiry", "rows", "omitted", "hidden-current"])(
		"only reads back acknowledged children with the same set proof: %s",
		async (change) => {
			const f = await eventSetFixture();
			effects.events.mockResolvedValue([...f.events].reverse());
			await resumeRecordedHomeDelegationApproval(f.context, f.input, f.run);
			const prepared = effects.claim.mock.calls[0]![1];
			effects.claim.mockClear();
			effects.dispatch.mockClear();
			effects.readiness.mockClear();
			f.run.status = "queued";
			f.run.childRunId = prepared.expectedChildRunId;
			f.run.delegatedTediId = "fictional-tedi";
			const proof = structuredClone(prepared.approvalEventSet);
			if (change === "digest") proof.digest = "0".repeat(64);
			if (change === "expiry") proof.originalExpiresAt = AT;
			if (change === "rows")
				proof.events[0].runtimeMetadata = { source: "tampered" };
			if (change === "hidden-current") {
				f.events[0]!.traceId = "changed-after-snapshot";
				expect(
					await delegationApprovalEventSetDigest({
						events: f.events,
						originalExpiresAt: f.originalExpiresAt,
					}),
				).toBe(f.input.approvalEventSet.digest);
			}
			f.run.metadata!.homeDelegationResume = {
				approvalEventId: f.input.approvalEventId,
				scopeDigest: prepared.scopeDigest,
				workItemId: "fictional-work",
				workItemVersion: 2,
				phase: "observed",
				expectedChildRunId: prepared.expectedChildRunId,
				...(change === "omitted" ? {} : { approvalEventSet: proof }),
				observation: {
					outcome: "acknowledged",
					observedChildRunId: prepared.expectedChildRunId,
				},
			};
			const result = resumeRecordedHomeDelegationApproval(
				f.context,
				f.input,
				f.run,
			);
			if (change === "same")
				expect((await result).run.childRunId).toBe(prepared.expectedChildRunId);
			else await expect(result).rejects.toThrow(/may already have effects/);
			noMutation();
			expect(effects.readiness).not.toHaveBeenCalled();
		},
	);
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
