import "./__tests__/kernel-runtime-work-mocks";
import { HomeRunSteering } from "../../kernel/run-steering";
import { describe, expect, it, vi } from "vite-plus/test";
import { kernelRuntimeTestHooks } from "./kernel-runtime/policy-normalization";
import {
	ORG_ID,
	normalizeKernelRuntimeRunInsert,
	normalizeWorkItemInsert,
	runningWorkAttempt,
	createKernelRuntimeDb,
	createContext,
	createKernelRuntimeClient,
	childRuntimeEvent,
} from "./__tests__/kernel-runtime-db";

describe("kernel runtime router: run-control", () => {
	it("#3 steerRun forwards the instruction to a live delegated child and records the outcome", async () => {
		const db = createKernelRuntimeDb();
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-steer-child-1",
				organizationId: ORG_ID,
				conversationId: "home:steer-child",
				status: "running",
				delegatedTediId: "tedi-cto",
				childRunId: "child-steer-1",
				childConversationId: "agent:main:main",
				metadata: {
					childRunStatus: "running",
					workItemId: "delegation-work-1",
				},
				createdAt: "2026-06-06T08:00:00.000Z",
				updatedAt: "2026-06-06T08:01:00.000Z",
			}),
		);
		const forwarder = vi.fn(async () => ({
			attempted: true,
			outcome: "succeeded" as const,
			childInjectRunId: "child-steer-inject-1",
		}));
		kernelRuntimeTestHooks.setChildSteerForwarderForTest(forwarder);
		const client = createKernelRuntimeClient(createContext(db));

		const steered = await client.steerRun({
			runId: "home-steer-child-1",
			instruction: "Prioritise the Acme migration evidence.",
		});

		expect(steered.run.status).toBe("running");
		expect(
			db.runs.find((run) => run.id === "home-steer-child-1")?.preview,
		).toBe("You added: Prioritise the Acme migration evidence.");
		expect(forwarder).toHaveBeenCalledTimes(1);
		expect(forwarder.mock.calls[0]?.[0]).toMatchObject({
			delegatedTediId: "tedi-cto",
			childRunId: "child-steer-1",
			childConversationId: "agent:main:main",
			workItemId: "delegation-work-1",
			instruction: "Prioritise the Acme migration evidence.",
			homeRunId: "home-steer-child-1",
		});
		expect(steered.run.metadata).toMatchObject({
			delegatedChildSteer: {
				attempted: true,
				outcome: "succeeded",
				childRunId: "child-steer-1",
				delegatedTediId: "tedi-cto",
				childInjectRunId: "child-steer-inject-1",
			},
		});
		// The run.steered runtime event carries the real forwarding outcome.
		const steerEvent = db.events.find(
			(event) =>
				event.kind === "message.received" &&
				event.runId === "home-steer-child-1" &&
				(event.runtimeMetadata as { source?: string } | null)?.source ===
					"kernelRuntime.steerRun",
		);
		expect(steerEvent?.runtimeMetadata).toMatchObject({
			delegatedChildSteerAttempted: true,
			delegatedChildSteerOutcome: "succeeded",
			delegatedChildSteerRunId: "child-steer-inject-1",
		});
		// Audit records the forwarding outcome too.
		expect(db.auditRows).toContainEqual(
			expect.objectContaining({
				action: "kernel.run.steered",
				resourceId: "home-steer-child-1",
				metadata: expect.objectContaining({
					delegatedChildSteerAttempted: true,
					delegatedChildSteerOutcome: "succeeded",
				}),
			}),
		);
	});

	it("#3 readRun surfaces the forwarded steering child result alongside the primary child", async () => {
		const db = createKernelRuntimeDb();
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-steer-child-result-1",
				organizationId: ORG_ID,
				conversationId: "home:steer-child-result",
				status: "completed",
				delegatedTediId: "tedi-cto",
				childRunId: "child-steer-result-primary-1",
				childConversationId: "agent:main:main",
				progressValue: 100,
				progressLabel: "Complete",
				progressDetail: "2 runtime events recorded",
				latestEventKind: "run.completed",
				latestEventAt: "2026-06-06T08:03:00.000Z",
				preview: "Primary child result without steering context.",
				metadata: {
					delegatedChildSteer: {
						attempted: true,
						outcome: "succeeded",
						childRunId: "child-steer-result-primary-1",
						delegatedTediId: "tedi-cto",
						childInjectRunId: "child-steer-result-inject-1",
						error: null,
						steeredAt: "2026-06-06T08:01:30.000Z",
					},
					latestSteeringInstruction: "Focus on Work Item evidence.",
				},
				createdAt: "2026-06-06T08:00:00.000Z",
				completedAt: "2026-06-06T08:03:00.000Z",
				updatedAt: "2026-06-06T08:03:00.000Z",
			}),
		);
		db.runtimeEvents.push(
			childRuntimeEvent({
				id: "runtime-steer-result-inject-message",
				kind: "message.completed",
				runId: "child-steer-result-inject-1",
				tediId: "tedi-cto",
				createdAt: "2026-06-06T08:03:10.000Z",
				payload: {
					role: "assistant",
					content: "Steering-aware result with Work Item evidence.",
				},
			}),
			childRuntimeEvent({
				id: "runtime-steer-result-inject-completed",
				kind: "run.completed",
				runId: "child-steer-result-inject-1",
				tediId: "tedi-cto",
				createdAt: "2026-06-06T08:03:10.000Z",
				payload: { status: "completed" },
			}),
		);
		const client = createKernelRuntimeClient(createContext(db));

		const read = await client.readRun({ runId: "home-steer-child-result-1" });

		expect(read.run.status).toBe("completed");
		expect(read.run.metadata).toMatchObject({
			childRunId: "child-steer-result-primary-1",
			childRunPreview: "Primary child result without steering context.",
			childRunStatus: "completed",
			delegatedChildSteerResult: {
				childRunId: "child-steer-result-inject-1",
				status: "completed",
				latestEventKind: "message.completed",
				latestEventAt: "2026-06-06T08:03:10.000Z",
				terminalAt: "2026-06-06T08:03:10.000Z",
				preview: "Steering-aware result with Work Item evidence.",
			},
		});
	});

	it("#3 steerRun records a failed child forward but never blocks the parent steer", async () => {
		const db = createKernelRuntimeDb();
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-steer-child-fail-1",
				organizationId: ORG_ID,
				conversationId: "home:steer-child-fail",
				status: "running",
				delegatedTediId: "tedi-cto",
				childRunId: "child-steer-fail-1",
				childConversationId: "agent:main:main",
				createdAt: "2026-06-06T08:00:00.000Z",
				updatedAt: "2026-06-06T08:01:00.000Z",
			}),
		);
		const forwarder = vi.fn(async () => ({
			attempted: true,
			outcome: "failed" as const,
			error: "child runtime unreachable",
		}));
		kernelRuntimeTestHooks.setChildSteerForwarderForTest(forwarder);
		const client = createKernelRuntimeClient(createContext(db));

		const steered = await client.steerRun({
			runId: "home-steer-child-fail-1",
			instruction: "Switch to the fallback plan.",
		});

		// Parent steer succeeds regardless of the child-side failure.
		expect(steered.run.status).toBe("running");
		expect(steered.run.metadata).toMatchObject({
			latestSteeringInstruction: "Switch to the fallback plan.",
			delegatedChildSteer: {
				attempted: true,
				outcome: "failed",
				error: "child runtime unreachable",
			},
		});
		const steerEvent = db.events.find(
			(event) =>
				event.kind === "message.received" &&
				event.runId === "home-steer-child-fail-1" &&
				(event.runtimeMetadata as { source?: string } | null)?.source ===
					"kernelRuntime.steerRun",
		);
		expect(steerEvent?.runtimeMetadata).toMatchObject({
			delegatedChildSteerAttempted: true,
			delegatedChildSteerOutcome: "failed",
			delegatedChildSteerError: "child runtime unreachable",
		});
	});

	it("#3 steerRun skips child forwarding when there is no delegated child", async () => {
		const db = createKernelRuntimeDb();
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-steer-no-child-1",
				organizationId: ORG_ID,
				conversationId: "home:steer-no-child",
				status: "running",
				createdAt: "2026-06-06T08:00:00.000Z",
				updatedAt: "2026-06-06T08:01:00.000Z",
			}),
		);
		const forwarder = vi.fn();
		kernelRuntimeTestHooks.setChildSteerForwarderForTest(
			forwarder as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setChildSteerForwarderForTest
			>[0],
		);
		const values = new Map<string, unknown>();
		const inbox = new HomeRunSteering({
			get: <T>(key: string) => values.get(key) as T | undefined,
			put: <T>(key: string, value: T) => {
				values.set(key, value);
			},
		});
		const client = createKernelRuntimeClient(
			createContext(db, {
				env: {
					KERNEL: {
						idFromName: (name: string) => name,
						get: () => ({
							controlRunSteering: async (
								input: Parameters<HomeRunSteering["control"]>[0],
							) => inbox.control(input),
						}),
					},
				},
			}),
		);

		const steered = await client.steerRun({
			runId: "home-steer-no-child-1",
			instruction: "No child to forward to.",
		});

		expect(forwarder).not.toHaveBeenCalled();
		expect(
			(steered.run.metadata as Record<string, unknown>).delegatedChildSteer,
		).toBeNull();
		const steerEvent = db.events.find(
			(event) =>
				event.kind === "message.received" &&
				event.runId === "home-steer-no-child-1" &&
				(event.runtimeMetadata as { source?: string } | null)?.source ===
					"kernelRuntime.steerRun",
		);
		expect(steerEvent?.runtimeMetadata).toMatchObject({
			delegatedChildSteerAttempted: false,
			delegatedChildSteerOutcome: "skipped",
		});
	});

	it("#3 cancelRun cascades the stop to a live delegated child and records the outcome", async () => {
		const db = createKernelRuntimeDb();
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-cancel-child-1",
				organizationId: ORG_ID,
				conversationId: "home:cancel-child",
				status: "running",
				metadata: {
					childRunStatus: "running",
					childRunPreview: "child still working",
					childRunLatestEventAt: "2026-06-06T08:01:00.000Z",
				},
				delegatedTediId: "tedi-cto",
				childRunId: "child-cancel-1",
				childConversationId: "agent:main:main",
				createdAt: "2026-06-06T08:00:00.000Z",
				updatedAt: "2026-06-06T08:01:00.000Z",
			}),
		);
		const stopper = vi.fn(async () => ({
			attempted: true,
			outcome: "succeeded" as const,
		}));
		kernelRuntimeTestHooks.setChildStopperForTest(stopper);
		const client = createKernelRuntimeClient(createContext(db));

		const canceled = await client.cancelRun({
			runId: "home-cancel-child-1",
			reason: "operator aborted the delegation",
		});

		expect(canceled.run.status).toBe("canceled");
		const persisted = db.runs.find((run) => run.id === "home-cancel-child-1")!;
		expect(canceled.run.completedAt).toBe(persisted.completedAt);
		expect(canceled.run.updatedAt).toBe(persisted.updatedAt);
		expect(canceled.run.metadata?.childRunPreview).toBe(persisted.preview);
		expect(canceled.run.progress).toMatchObject({
			current: 100,
			label: "Stopped",
		});
		for (let read = 0; read < 2; read += 1) {
			const result = await client.readRun({ runId: "home-cancel-child-1" });
			expect(result.run).toMatchObject({
				status: "canceled",
				completedAt: persisted.completedAt,
				updatedAt: persisted.updatedAt,
				progress: { current: 100, label: "Stopped" },
				metadata: { childRunPreview: persisted.preview },
			});
		}
		expect(stopper).toHaveBeenCalledTimes(1);
		expect(stopper.mock.calls[0]?.[0]).toMatchObject({
			delegatedTediId: "tedi-cto",
			childRunId: "child-cancel-1",
			childConversationId: "agent:main:main",
			reason: "operator aborted the delegation",
		});
		expect(canceled.run.metadata).toMatchObject({
			delegatedChildStop: {
				attempted: true,
				outcome: "succeeded",
				childRunId: "child-cancel-1",
				delegatedTediId: "tedi-cto",
			},
		});
		const cancelEvent = db.events.find(
			(event) =>
				event.kind === "run.canceled" && event.runId === "home-cancel-child-1",
		);
		expect(cancelEvent?.runtimeMetadata).toMatchObject({
			delegatedChildStopAttempted: true,
			delegatedChildStopOutcome: "succeeded",
		});
		expect(db.auditRows).toContainEqual(
			expect.objectContaining({
				action: "kernel.run.canceled",
				resourceId: "home-cancel-child-1",
				metadata: expect.objectContaining({
					delegatedChildStopAttempted: true,
					delegatedChildStopOutcome: "succeeded",
				}),
			}),
		);
	});

	it("#3 cancelRun also stops the live steer injection child", async () => {
		const db = createKernelRuntimeDb();
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-cancel-steer-child-1",
				organizationId: ORG_ID,
				conversationId: "home:cancel-steer-child",
				status: "running",
				delegatedTediId: "tedi-cto",
				childRunId: "child-cancel-primary-1",
				childConversationId: "agent:main:main",
				metadata: {
					delegatedChildSteer: {
						childInjectRunId: "child-cancel-steer-1",
					},
				},
				createdAt: "2026-06-06T08:00:00.000Z",
				updatedAt: "2026-06-06T08:01:00.000Z",
			}),
		);
		const stopper = vi.fn(async (input: { childRunId: string }) =>
			input.childRunId === "child-cancel-steer-1"
				? {
						attempted: true,
						outcome: "failed" as const,
						error: "steer runtime reconnecting",
					}
				: { attempted: true, outcome: "succeeded" as const },
		);
		kernelRuntimeTestHooks.setChildStopperForTest(stopper);
		const client = createKernelRuntimeClient(createContext(db));

		const canceled = await client.cancelRun({
			runId: "home-cancel-steer-child-1",
			reason: "operator canceled parent and steer",
		});

		expect(canceled.run.status).toBe("canceled");
		expect(stopper).toHaveBeenCalledTimes(2);
		expect(stopper.mock.calls.map(([input]) => input.childRunId)).toEqual([
			"child-cancel-primary-1",
			"child-cancel-steer-1",
		]);
		expect(db.submissionAbortStamps.map((stamp) => stamp.submissionId)).toEqual(
			[
				"sub:home-cancel-steer-child-1",
				"sub:child-cancel-primary-1",
				"sub:child-cancel-steer-1",
			],
		);
		expect(canceled.run.metadata).toMatchObject({
			delegatedChildStop: {
				attempted: true,
				outcome: "failed",
				childRunId: "child-cancel-primary-1",
			},
			delegatedChildStops: [
				{
					attempted: true,
					outcome: "succeeded",
					childRunId: "child-cancel-primary-1",
				},
				{
					attempted: true,
					outcome: "failed",
					childRunId: "child-cancel-steer-1",
					error: "steer runtime reconnecting",
				},
			],
		});
		const cancelEvent = db.events.find(
			(event) =>
				event.kind === "run.canceled" &&
				event.runId === "home-cancel-steer-child-1",
		);
		expect(cancelEvent?.payload).toMatchObject({
			childRunIds: ["child-cancel-primary-1", "child-cancel-steer-1"],
		});
		expect(cancelEvent?.runtimeMetadata).toMatchObject({
			delegatedChildStopAttempted: true,
			delegatedChildStopOutcome: "failed",
		});
	});

	it("cancelRun best-effort aborts the KernelDO's in-flight turn AFTER the run row is durably canceled", async () => {
		const db = createKernelRuntimeDb();
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-cancel-do-1",
				organizationId: ORG_ID,
				conversationId: "home:cancel-do",
				status: "running",
				createdAt: "2026-06-06T08:00:00.000Z",
				updatedAt: "2026-06-06T08:01:00.000Z",
			}),
		);
		const canceler = vi.fn(async (input: { runId: string }) => {
			// Assert-on-call: by the time this fires, the run row is already
			// durably canceled — the DO-abort is purely a token-burn optimization,
			// never a dependency the settle correctness relies on.
			const row = db.runs.find((r) => r.id === input.runId);
			expect(row?.status).toBe("canceled");
			return true;
		});
		kernelRuntimeTestHooks.setDoTurnCancelerForTest(canceler);
		const client = createKernelRuntimeClient(createContext(db));

		const canceled = await client.cancelRun({ runId: "home-cancel-do-1" });

		expect(canceled.run.status).toBe("canceled");
		expect(canceler).toHaveBeenCalledTimes(1);
		expect(canceler.mock.calls[0]?.[0]).toMatchObject({
			organizationId: ORG_ID,
			runId: "home-cancel-do-1",
		});
	});

	it("cancelRun stays fail-soft when the DO turn-canceler throws — the run still settles canceled", async () => {
		const db = createKernelRuntimeDb();
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-cancel-do-2",
				organizationId: ORG_ID,
				conversationId: "home:cancel-do-2",
				status: "running",
				createdAt: "2026-06-06T08:00:00.000Z",
				updatedAt: "2026-06-06T08:01:00.000Z",
			}),
		);
		kernelRuntimeTestHooks.setDoTurnCancelerForTest(async () => {
			throw new Error("DO unreachable — simulated");
		});
		const client = createKernelRuntimeClient(createContext(db));

		const canceled = await client.cancelRun({ runId: "home-cancel-do-2" });

		expect(canceled.run.status).toBe("canceled");
	});

	it.each([
		[undefined, "Stopped. You can ask me to try again when you're ready."],
		[
			"Stopped from Home composer",
			"Stopped. You can ask me to try again when you're ready.",
		],
		[
			"Cost containment: work-order budget exceeded; schema failures",
			"I stopped because this was taking much longer than expected. Want me to continue?",
		],
	])(
		"cancelRun keeps technical reasons out of the reply (%s)",
		async (reason, preview) => {
			const db = createKernelRuntimeDb();
			db.runs.push(
				normalizeKernelRuntimeRunInsert({
					id: "home-cancel-plain",
					organizationId: ORG_ID,
					conversationId: "home:cancel-plain",
					status: "running",
					createdAt: "2026-06-06T08:00:00.000Z",
				}),
			);
			const client = createKernelRuntimeClient(createContext(db));
			const canceled = await client.cancelRun({
				runId: "home-cancel-plain",
				reason,
			});
			expect(
				db.runs.find((run) => run.id === "home-cancel-plain")?.preview,
			).toBe(preview);
			expect(canceled.run.metadata?.cancelReason).toBe(reason ?? null);
			const read = await client.readRun({ runId: "home-cancel-plain" });
			expect(read.run.metadata?.childRunPreview).toBe(preview);
		},
	);

	it("cancelRun resolves the DO via kernel.idFromName(organizationId) — the same identity the enqueue path uses", async () => {
		const db = createKernelRuntimeDb();
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-cancel-do-3",
				organizationId: ORG_ID,
				conversationId: "home:cancel-do-3",
				status: "running",
				createdAt: "2026-06-06T08:00:00.000Z",
				updatedAt: "2026-06-06T08:01:00.000Z",
			}),
		);
		const cancelTurnCalls: Array<{ doId: string; runId: string }> = [];
		const fakeKernelNamespace = {
			idFromName: (name: string) => name,
			get: (doId: string) => ({
				cancelTurn: async (runId: string) => {
					cancelTurnCalls.push({ doId, runId });
					return true;
				},
			}),
		};
		const client = createKernelRuntimeClient(
			createContext(db, { env: { KERNEL: fakeKernelNamespace } }),
		);

		const canceled = await client.cancelRun({ runId: "home-cancel-do-3" });

		expect(canceled.run.status).toBe("canceled");
		expect(cancelTurnCalls).toEqual([
			{ doId: ORG_ID, runId: "home-cancel-do-3" },
		]);
	});

	it("cancelRun stamps durable abort intent on the parent AND the delegated child submissions before acting", async () => {
		const db = createKernelRuntimeDb();
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-cancel-stamp-1",
				organizationId: ORG_ID,
				conversationId: "home:cancel-stamp",
				status: "running",
				delegatedTediId: "tedi-cto",
				childRunId: "child-cancel-stamp-1",
				childConversationId: "agent:main:main",
				createdAt: "2026-06-06T08:00:00.000Z",
				updatedAt: "2026-06-06T08:01:00.000Z",
			}),
		);
		// The child stop RPC fails — the durable intent must already be recorded
		// for both submissions regardless (stamp-before-action). Capture the stamps
		// visible at the moment the stopper fires so the ordering is pinned, not
		// just asserted after the fact.
		let stampsWhenStopperFired: string[] = [];
		const stopper = vi.fn(async () => {
			stampsWhenStopperFired = db.submissionAbortStamps.map(
				(s) => s.submissionId,
			);
			return {
				attempted: true,
				outcome: "failed" as const,
				error: "child runtime unreachable",
			};
		});
		kernelRuntimeTestHooks.setChildStopperForTest(stopper);
		const client = createKernelRuntimeClient(createContext(db));

		const canceled = await client.cancelRun({
			runId: "home-cancel-stamp-1",
			reason: "operator abort",
		});

		expect(canceled.run.status).toBe("canceled");
		expect(db.submissionAbortStamps.map((s) => s.submissionId)).toEqual([
			"sub:home-cancel-stamp-1",
			"sub:child-cancel-stamp-1",
		]);
		// Stamp-before-action: both stamps had already landed when the (failed)
		// child-stop RPC fired — a lost stop still leaves durable intent behind.
		expect(stopper).toHaveBeenCalledTimes(1);
		expect(stampsWhenStopperFired).toEqual([
			"sub:home-cancel-stamp-1",
			"sub:child-cancel-stamp-1",
		]);
	});

	it("cancelRun with no delegated child stamps only the parent submission", async () => {
		const db = createKernelRuntimeDb();
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-cancel-stamp-solo",
				organizationId: ORG_ID,
				conversationId: "home:cancel-stamp-solo",
				status: "running",
				createdAt: "2026-06-06T08:00:00.000Z",
				updatedAt: "2026-06-06T08:01:00.000Z",
			}),
		);
		const client = createKernelRuntimeClient(createContext(db));

		const canceled = await client.cancelRun({
			runId: "home-cancel-stamp-solo",
			reason: "operator abort",
		});

		expect(canceled.run.status).toBe("canceled");
		expect(db.submissionAbortStamps.map((s) => s.submissionId)).toEqual([
			"sub:home-cancel-stamp-solo",
		]);
	});

	it("cancelRun immediately releases a reused canonical Work Item and clears execution pointers", async () => {
		const db = createKernelRuntimeDb();
		const homeRunId = "home-cancel-reused-work-item-1";
		const childRunId = "child-cancel-reused-work-item-1";
		const workItemId = "wi-cancel-reused-work-item-1";
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: homeRunId,
				organizationId: ORG_ID,
				conversationId: "home:cancel-reused-work-item",
				status: "running",
				delegatedTediId: "tedi-cto",
				childRunId,
				childConversationId: "agent:main:main",
				metadata: { workItemId },
				createdAt: "2026-06-06T08:00:00.000Z",
				updatedAt: "2026-06-06T08:01:00.000Z",
			}),
		);
		db.workItemRows.push(
			normalizeWorkItemInsert({
				id: workItemId,
				orgId: ORG_ID,
				title: "Reusable graph task",
				disposition: "accepted",
				accountableOwnerType: "tedi",
				accountableOwnerId: "tedi-cto",
				sourceIntentId: "original-operator-intent",
				sourceSessionKey: "operator-session",
				metadata: {
					canonicalWorkItemReuse: true,
					homeRunId,
					childRunId,
				},
				createdAt: "2026-06-06T07:00:00.000Z",
			}),
		);
		db.workAttemptRows.push(
			runningWorkAttempt(workItemId, "tedi-cto", childRunId),
		);
		kernelRuntimeTestHooks.setChildStopperForTest(
			vi.fn(async () => ({
				attempted: true,
				outcome: "succeeded" as const,
			})),
		);
		const client = createKernelRuntimeClient(createContext(db));

		const canceled = await client.cancelRun({
			runId: homeRunId,
			reason: "operator preserves task for retry",
		});

		expect(canceled.run.status).toBe("canceled");
		expect(
			db.workAttemptRows.find((attempt) => attempt.workItemId === workItemId),
		).toMatchObject({
			runtimeState: "cancelled",
			outcome: "cancelled",
			executorId: "tedi-cto",
		});
	});

	it("#3 cancelRun carries completed steering proof into the canceled Work Item disposition", async () => {
		const db = createKernelRuntimeDb();
		const homeRunId = "home-cancel-steer-proof-1";
		const childRunId = "child-cancel-steer-proof-primary-1";
		const steerRunId = "child-cancel-steer-proof-inject-1";
		const workItemId = "wi-cancel-steer-proof-1";
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: homeRunId,
				organizationId: ORG_ID,
				conversationId: "home:cancel-steer-proof",
				status: "running",
				delegatedTediId: "tedi-cto",
				childRunId,
				childConversationId: "agent:main:main",
				metadata: {
					delegatedTediId: "tedi-cto",
					workItemId,
					delegatedChildSteer: {
						attempted: true,
						outcome: "succeeded",
						childRunId,
						childInjectRunId: steerRunId,
					},
				},
				createdAt: "2026-06-06T08:00:00.000Z",
				updatedAt: "2026-06-06T08:01:00.000Z",
			}),
		);
		db.workItemRows.push(
			normalizeWorkItemInsert({
				id: workItemId,
				orgId: ORG_ID,
				title: "Cancel steer proof",
				disposition: "accepted",
				accountableOwnerType: "tedi",
				accountableOwnerId: "tedi-cto",
				sourceIntentId: childRunId,
				sourceSessionKey: "home:cancel-steer-proof",
				metadata: { homeRunId, delegatedTediId: "tedi-cto" },
				createdAt: "2026-06-06T08:00:00.000Z",
			}),
		);
		db.workAttemptRows.push(
			runningWorkAttempt(workItemId, "tedi-cto", childRunId),
		);
		db.runtimeEvents.push(
			childRuntimeEvent({
				id: "runtime-primary-started",
				kind: "run.started",
				runId: childRunId,
				tediId: "tedi-cto",
				createdAt: "2026-06-06T08:01:00.000Z",
				payload: { status: "queued" },
			}),
			childRuntimeEvent({
				id: "runtime-primary-context",
				kind: "context.injected",
				runId: childRunId,
				tediId: "tedi-cto",
				createdAt: "2026-06-06T08:01:30.000Z",
				payload: { source: "compiled-directives" },
			}),
		);
		const steeringProofEvents = [
			childRuntimeEvent({
				id: "runtime-steer-proof-message",
				kind: "message.completed",
				runId: steerRunId,
				tediId: "tedi-cto",
				createdAt: "2026-06-06T08:02:00.000Z",
				payload: {
					role: "assistant",
					content:
						"Stopped. request_workstation was not reached and repo_commit was not reached.",
				},
			}),
			childRuntimeEvent({
				id: "runtime-steer-proof-completed",
				kind: "run.completed",
				runId: steerRunId,
				tediId: "tedi-cto",
				createdAt: "2026-06-06T08:03:00.000Z",
				payload: { status: "completed" },
			}),
		];
		const stopper = vi.fn(async () => ({
			attempted: true,
			outcome: "succeeded" as const,
		}));
		kernelRuntimeTestHooks.setChildStopperForTest(stopper);
		const client = createKernelRuntimeClient(createContext(db));

		await client.cancelRun({
			runId: homeRunId,
			reason: "operator stopped after steering proof",
		});
		db.runtimeEvents.push(...steeringProofEvents);
		await client.readRun({ runId: homeRunId });

		const terminalComment = db.workItemCommentRows.find(
			(comment) => comment.id === `${workItemId}:terminal:canceled`,
		);
		expect(terminalComment).toMatchObject({
			body: expect.stringContaining("Latest steering evidence"),
			metadata: expect.objectContaining({
				childRunId,
				childRunStatus: "canceled",
				hasProof: false,
				steeringProof: expect.objectContaining({
					childRunId: steerRunId,
					hasProof: true,
					transcriptPreview: expect.stringContaining(
						"repo_commit was not reached",
					),
				}),
			}),
		});
		expect(
			db.workItemRows.find((item) => item.id === workItemId),
		).toMatchObject({
			disposition: "cancelled",
		});
	});

	it("#3 cancelRun reconciles an already-terminal delegated child instead of overwriting it", async () => {
		const db = createKernelRuntimeDb();
		const homeRunId = "home-cancel-child-terminal-race-1";
		const childRunId = "child-cancel-terminal-race-1";
		const workItemId = "wi-cancel-terminal-race-1";
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: homeRunId,
				organizationId: ORG_ID,
				conversationId: "home:cancel-child-terminal-race",
				status: "running",
				delegatedTediId: "tedi-cto",
				childRunId,
				childConversationId: "agent:main:main",
				metadata: {
					delegatedTediId: "tedi-cto",
					workItemId,
				},
				createdAt: "2026-06-06T08:00:00.000Z",
				updatedAt: "2026-06-06T08:01:00.000Z",
			}),
		);
		db.workItemRows.push(
			normalizeWorkItemInsert({
				id: workItemId,
				orgId: ORG_ID,
				title: "Cancel race proof",
				disposition: "accepted",
				accountableOwnerType: "tedi",
				accountableOwnerId: "tedi-cto",
				sourceIntentId: childRunId,
				sourceSessionKey: "home:cancel-child-terminal-race",
				metadata: { homeRunId, delegatedTediId: "tedi-cto" },
				createdAt: "2026-06-06T08:00:00.000Z",
			}),
		);
		db.workAttemptRows.push(
			runningWorkAttempt(workItemId, "tedi-cto", childRunId),
		);
		db.runtimeEvents.push(
			childRuntimeEvent({
				id: "runtime-cancel-race-message",
				kind: "message.completed",
				runId: childRunId,
				tediId: "tedi-cto",
				createdAt: "2026-06-06T08:02:00.000Z",
				payload: {
					role: "assistant",
					content: "Completed CTO patch proposal with proof text.",
				},
			}),
			childRuntimeEvent({
				id: "runtime-cancel-race-completed",
				kind: "run.completed",
				runId: childRunId,
				tediId: "tedi-cto",
				createdAt: "2026-06-06T08:03:00.000Z",
				payload: { status: "completed" },
			}),
		);
		const stopper = vi.fn(async () => ({
			attempted: true,
			outcome: "succeeded" as const,
		}));
		kernelRuntimeTestHooks.setChildStopperForTest(stopper);
		const client = createKernelRuntimeClient(createContext(db));

		const result = await client.cancelRun({
			runId: homeRunId,
			reason: "operator canceled after child completed",
		});

		expect(result.run.status).toBe("completed");
		expect(stopper).not.toHaveBeenCalled();
		expect(db.runs.find((run) => run.id === homeRunId)).toMatchObject({
			status: "completed",
			latestEventKind: "run.completed",
			outputMessageId: `${homeRunId}:async-completion:assistant`,
		});
		expect(
			db.events.some(
				(event) => event.kind === "run.canceled" && event.runId === homeRunId,
			),
		).toBe(false);
		expect(
			db.auditRows.some(
				(row) =>
					(row as Record<string, unknown>).action === "kernel.run.canceled" &&
					(row as Record<string, unknown>).resourceId === homeRunId,
			),
		).toBe(false);
		expect(
			db.workAttemptRows.find((attempt) => attempt.workItemId === workItemId),
		).toMatchObject({
			runtimeState: "finished",
			outcome: "succeeded",
		});
		expect(
			db.workItemCommentRows.find(
				(comment) => comment.id === `${workItemId}:terminal:completed`,
			),
		).toMatchObject({
			metadata: expect.objectContaining({
				childRunStatus: "completed",
				hasProof: true,
			}),
		});
	});

	it("#3 cancelRun skips the child stop cascade when there is no delegated child", async () => {
		const db = createKernelRuntimeDb();
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-cancel-no-child-1",
				organizationId: ORG_ID,
				conversationId: "home:cancel-no-child",
				status: "running",
				createdAt: "2026-06-06T08:00:00.000Z",
				updatedAt: "2026-06-06T08:01:00.000Z",
			}),
		);
		const stopper = vi.fn();
		kernelRuntimeTestHooks.setChildStopperForTest(
			stopper as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setChildStopperForTest
			>[0],
		);
		const client = createKernelRuntimeClient(createContext(db));

		const canceled = await client.cancelRun({
			runId: "home-cancel-no-child-1",
		});

		expect(canceled.run.status).toBe("canceled");
		expect(stopper).not.toHaveBeenCalled();
		expect(
			(canceled.run.metadata as Record<string, unknown>).delegatedChildStop,
		).toBeNull();
		const cancelEvent = db.events.find(
			(event) =>
				event.kind === "run.canceled" &&
				event.runId === "home-cancel-no-child-1",
		);
		expect(cancelEvent?.runtimeMetadata).toMatchObject({
			delegatedChildStopAttempted: false,
			delegatedChildStopOutcome: "skipped",
		});
	});

	it("#3 run-set reconcile stops a still-running delegated child of an already-canceled parent (post-cancel race)", async () => {
		// The exact cancel race: cancelKernelRunCore ran while childRunId was
		// still null (skipped its cascade), the dispatch then linked the child
		// onto the canceled row. The next run-set read must stop the child via
		// the same child-stop mechanism, exactly once, and keep the parent
		// canceled.
		const db = createKernelRuntimeDb();
		const childRunId = "tedi-cto:mcp:home-cancel-race-1_auto_tedi-cto";
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-cancel-race-1",
				organizationId: ORG_ID,
				conversationId: "home:cancel-race",
				status: "canceled",
				delegatedTediId: "tedi-cto",
				childRunId,
				childConversationId: "agent:main:delegation-x",
				// Cancel core saw no child → its cascade marker is null.
				metadata: { delegatedChildStop: null },
				createdAt: "2026-06-06T08:00:00.000Z",
				completedAt: "2026-06-06T08:00:30.000Z",
				updatedAt: "2026-06-06T08:00:30.000Z",
			}),
		);
		// The zombie child is live: it started and never reached a terminal event.
		db.runtimeEvents.push(
			childRuntimeEvent({
				createdAt: "2026-06-06T08:01:00.000Z",
				id: "child-cancel-race-started",
				kind: "run.started",
				payload: { status: "running" },
				runId: childRunId,
				tediId: "tedi-cto",
			}),
		);
		const stopper = vi.fn(async () => ({
			attempted: true,
			outcome: "succeeded" as const,
		}));
		kernelRuntimeTestHooks.setChildStopperForTest(stopper);
		const client = createKernelRuntimeClient(createContext(db));

		const runSet = await client.readRunSet({
			conversationId: "home:cancel-race",
			limit: 10,
		});
		const run = runSet.runSet.runs.find(
			(candidate) => candidate.id === "home-cancel-race-1",
		);
		// The parent stays canceled — never revived by live child activity.
		expect(run?.status).toBe("canceled");
		expect(stopper).toHaveBeenCalledTimes(1);
		expect(stopper.mock.calls[0]?.[0]).toMatchObject({
			delegatedTediId: "tedi-cto",
			childRunId,
			childConversationId: "agent:main:delegation-x",
			reason: "Parent Home run canceled by operator",
		});
		// Marker persisted on the run row so the stop is single-shot.
		const row = db.runs.find(
			(candidate) => candidate.id === "home-cancel-race-1",
		);
		expect(
			(row?.metadata as Record<string, unknown> | null)
				?.canceledChildStopReconcile,
		).toMatchObject({
			attempted: true,
			outcome: "succeeded",
			childRunId,
		});

		// A second read must not fire the stopper again (marker-gated).
		await client.readRunSet({ conversationId: "home:cancel-race", limit: 10 });
		expect(stopper).toHaveBeenCalledTimes(1);
	});

	it("#3 run-set reconcile records a skipped marker (no stop RPC) when the canceled parent's child already settled", async () => {
		const db = createKernelRuntimeDb();
		const childRunId = "tedi-cto:mcp:home-cancel-settled-1_auto_tedi-cto";
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-cancel-settled-1",
				organizationId: ORG_ID,
				conversationId: "home:cancel-settled",
				status: "canceled",
				delegatedTediId: "tedi-cto",
				childRunId,
				childConversationId: "agent:main:delegation-y",
				metadata: { delegatedChildStop: null },
				createdAt: "2026-06-06T08:00:00.000Z",
				completedAt: "2026-06-06T08:00:30.000Z",
				updatedAt: "2026-06-06T08:00:30.000Z",
			}),
		);
		db.runtimeEvents.push(
			childRuntimeEvent({
				createdAt: "2026-06-06T08:01:00.000Z",
				id: "child-cancel-settled-message",
				kind: "message.completed",
				payload: { role: "assistant", content: "Done before the cancel." },
				runId: childRunId,
				tediId: "tedi-cto",
			}),
			childRuntimeEvent({
				createdAt: "2026-06-06T08:01:01.000Z",
				id: "child-cancel-settled-completed",
				kind: "run.completed",
				payload: { status: "completed" },
				runId: childRunId,
				tediId: "tedi-cto",
			}),
		);
		const stopper = vi.fn(async () => ({
			attempted: true,
			outcome: "succeeded" as const,
		}));
		kernelRuntimeTestHooks.setChildStopperForTest(stopper);
		const client = createKernelRuntimeClient(createContext(db));

		await client.readRunSet({
			conversationId: "home:cancel-settled",
			limit: 10,
		});

		expect(stopper).not.toHaveBeenCalled();
		const row = db.runs.find(
			(candidate) => candidate.id === "home-cancel-settled-1",
		);
		expect(
			(row?.metadata as Record<string, unknown> | null)
				?.canceledChildStopReconcile,
		).toMatchObject({
			attempted: false,
			outcome: "skipped",
			childRunStatus: "completed",
		});
	});

	it("#5 surfaces intermediate child progress as an idempotent work-card event without polluting the transcript", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		kernelRuntimeTestHooks.setDelegateRunnerForTest(async (input) => ({
			childConversationId: "agent:main:main",
			childRunId: input.childRunId,
			status: "queued",
		}));

		await client.enqueueMessage({
			conversationId: "home:progress",
			content: "Ask Echo to keep working",
			delegateToTediId: "tedi-echo",
			idempotencyKey: "home-progress-1",
		});
		const childRunId = "tedi-echo:mcp:home-progress-1_delegate_tedi-echo";
		// A non-terminal child advance: the worker started and emitted a streaming
		// delta, but has not completed.
		db.runtimeEvents.push(
			childRuntimeEvent({
				createdAt: "2026-06-06T08:01:00.000Z",
				id: "child-progress-started",
				kind: "run.started",
				payload: { status: "running" },
				runId: childRunId,
				tediId: "tedi-echo",
			}),
			childRuntimeEvent({
				createdAt: "2026-06-06T08:02:00.000Z",
				delta: "Halfway through the migration audit.",
				id: "child-progress-delta",
				kind: "message.delta",
				payload: {
					status: "running",
					content: "Halfway through the migration audit.",
				},
				runId: childRunId,
				tediId: "tedi-echo",
			}),
		);

		await client.readRunSet({ conversationId: "home:progress", limit: 10 });

		const progressEvents = db.events.filter(
			(event) =>
				event.kind === "message.delta" &&
				(event.runtimeMetadata as { source?: string } | null)?.source ===
					"kernelRuntime.delegationProgress",
		);
		expect(progressEvents).toHaveLength(1);
		expect(progressEvents[0]).toMatchObject({
			runId: "home-progress-1",
			childRunId,
			delegatedTediId: "tedi-echo",
		});
		// The HomeRun status collapses to "running", but the richer child
		// sub-state (a streaming delta) is preserved in the event metadata.
		expect(progressEvents[0]?.runtimeMetadata).toMatchObject({
			asyncProgress: true,
			childRunStatus: "streaming",
		});

		// Idempotent: a second reconcile poll over the same child event does not
		// duplicate the progress event.
		await client.readRunSet({ conversationId: "home:progress", limit: 10 });
		expect(
			db.events.filter(
				(event) =>
					event.kind === "message.delta" &&
					(event.runtimeMetadata as { source?: string } | null)?.source ===
						"kernelRuntime.delegationProgress",
			),
		).toHaveLength(1);

		// The progress event never reaches the Home chat transcript.
		const messages = await client.readMessages({
			conversationId: "home:progress",
			limit: 50,
		});
		expect(
			messages.messages.some((message) => message.id.includes("message.delta")),
		).toBe(false);
		expect(
			messages.messages.some((message) =>
				typeof message.content === "string"
					? message.content.includes("Halfway through the migration audit.")
					: false,
			),
		).toBe(false);
	});

	it("cancelRun stamps kernelRoute from the run row onto the audit event so home-reflection-producer can mine the rationale", async () => {
		// A delegated run that already carried a kernelRoute (stamped by turn-work.ts
		// when the kernel completed its routing decision). The cancel path must forward
		// it into the audit event metadata so home-reflection-producer's
		// extractRouteRationale fires the "because:" clause.
		const db = createKernelRuntimeDb();
		const kernelRoute = {
			routeKind: "delegate_tedi",
			rationale:
				"cfo owns finance reconciliation and this is a quarterly close",
			confidence: 0.88,
			effortClass: "multi_hop_read",
		};
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-cancel-g3-1",
				organizationId: ORG_ID,
				conversationId: "home:cancel-g3",
				status: "running",
				delegatedTediId: "tedi-cfo",
				childRunId: "child-g3-1",
				childConversationId: "agent:main:main",
				metadata: {
					delegatedTediId: "tedi-cfo",
					kernelRoute,
					source: "kernelRuntime.enqueueMessage",
				},
				createdAt: "2026-06-23T08:00:00.000Z",
				updatedAt: "2026-06-23T08:01:00.000Z",
			}),
		);
		kernelRuntimeTestHooks.setChildStopperForTest(async () => ({
			attempted: true,
			outcome: "succeeded" as const,
		}));
		const client = createKernelRuntimeClient(createContext(db));

		const canceled = await client.cancelRun({
			runId: "home-cancel-g3-1",
			reason: "strategy changed",
		});

		expect(canceled.run.status).toBe("canceled");

		// The audit event must carry kernelRoute so the producer's route-rationale path fires.
		const auditRow = db.auditRows.find(
			(r) =>
				(r as Record<string, unknown>).action === "kernel.run.canceled" &&
				(r as Record<string, unknown>).resourceId === "home-cancel-g3-1",
		) as Record<string, unknown> | undefined;
		expect(auditRow).toBeDefined();
		const auditMeta = auditRow?.metadata as Record<string, unknown> | undefined;
		expect(auditMeta?.kernelRoute).toMatchObject({
			routeKind: "delegate_tedi",
			rationale:
				"cfo owns finance reconciliation and this is a quarterly close",
		});
		// delegatedTediId also present (producer needs it for the tediId + clause).
		expect(auditMeta?.delegatedTediId).toBe("tedi-cfo");
	});

	it("fail-soft: cancelRun with no kernelRoute on the run → audit event carries kernelRoute null, not a thrown error", async () => {
		const db = createKernelRuntimeDb();
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-cancel-g3-nosig",
				organizationId: ORG_ID,
				conversationId: "home:cancel-g3-nosig",
				status: "running",
				delegatedTediId: "tedi-cfo",
				metadata: {
					delegatedTediId: "tedi-cfo",
					// no kernelRoute — producer must fall back to bare fact text
					source: "kernelRuntime.enqueueMessage",
				},
				createdAt: "2026-06-23T08:00:00.000Z",
				updatedAt: "2026-06-23T08:01:00.000Z",
			}),
		);
		kernelRuntimeTestHooks.setChildStopperForTest(async () => ({
			attempted: false,
			outcome: "skipped" as const,
		}));
		const client = createKernelRuntimeClient(createContext(db));

		const canceled = await client.cancelRun({
			runId: "home-cancel-g3-nosig",
		});

		expect(canceled.run.status).toBe("canceled");
		const auditRow = db.auditRows.find(
			(r) =>
				(r as Record<string, unknown>).action === "kernel.run.canceled" &&
				(r as Record<string, unknown>).resourceId === "home-cancel-g3-nosig",
		) as Record<string, unknown> | undefined;
		const auditMeta = auditRow?.metadata as Record<string, unknown> | undefined;
		// Absent kernelRoute → null in audit metadata (fail-soft, no throw).
		expect(auditMeta?.kernelRoute).toBeNull();
	});
});
