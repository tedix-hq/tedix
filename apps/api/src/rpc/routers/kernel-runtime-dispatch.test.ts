import { kernelRuntimeEvents, kernelRuntimeRuns } from "@tedix/db/schema";
import { policyPacks } from "@tedix/db/schema/control-plane";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import {
	clampPlanObjective,
	detectsHomePlanningRequest,
	type HomePlanningTarget,
	selectedHomePlanTargets,
} from "./kernel/plan-dispatch";
import { remainingKernelTurnBudgetMs } from "./kernel-runtime/policy-normalization";
import { kernelRuntimeTestHooks } from "./kernel-runtime/policy-normalization";

import {
	ORG_ID,
	NATIVE_EXECUTION_REQUIREMENT,
	WORKSTATION_EXECUTION_REQUIREMENT,
	type WorkItemRow,
	type WorkAttemptRow,
	type PolicyPackRow,
	createKernelRuntimeDb,
	createContext,
	createKernelRuntimeClient,
} from "./__tests__/kernel-runtime-db";

vi.mock("@tedix/db/queries/work-items/admissions", async (importOriginal) => {
	const original =
		await importOriginal<
			typeof import("@tedix/db/queries/work-items/admissions")
		>();
	return {
		...original,
		evaluateAndRecordWorkAdmission: vi.fn(async (_db, input) => ({
			id: `admission:${input.workItemId}:${input.executorId}`,
			expiresAt: new Date(
				Date.parse(input.now) + input.leaseTtlMs,
			).toISOString(),
			decision: "admitted" as const,
		})),
	};
});

vi.mock("@tedix/db/queries/work-items/attempts", async (importOriginal) => {
	const original =
		await importOriginal<
			typeof import("@tedix/db/queries/work-items/attempts")
		>();
	return {
		...original,
		startWorkItemAttempt: vi.fn(
			async (
				db: unknown,
				input: {
					admissionId: string;
					executor: { type: "tedi" | "external_agent"; id: string };
					expiresAt?: string;
					metadata?: Record<string, unknown>;
					orgId: string;
					runId?: string;
					startedAt?: string;
					workItemId: string;
				},
			) => {
				const fake = db as {
					workAttemptRows: WorkAttemptRow[];
					workItemRows: WorkItemRow[];
				};
				const workItem = fake.workItemRows.find(
					(row) => row.id === input.workItemId,
				);
				if (!workItem) throw new Error(`Missing Work Item ${input.workItemId}`);
				const startedAt = input.startedAt ?? new Date().toISOString();
				const attempt = {
					id: crypto.randomUUID(),
					admissionId: input.admissionId,
					workItemId: input.workItemId,
					orgId: input.orgId,
					executorType: input.executor.type,
					executorId: input.executor.id,
					executorSessionId: null,
					externalSessionKey: null,
					runId: input.runId ?? null,
					runtimeState: "running",
					outcome: null,
					attemptNumber: fake.workAttemptRows.length + 1,
					startedAt,
					heartbeatAt: startedAt,
					expiresAt: input.expiresAt ?? null,
					finishedAt: null,
					summary: null,
					version: 1,
					metadata: input.metadata ?? {},
				} as WorkAttemptRow;
				fake.workAttemptRows.push(attempt);
				return { workItem, attempt, resumed: false };
			},
		),
		settleWorkItemAttempt: vi.fn(
			async (
				db: unknown,
				input: {
					attemptId: string;
					outcome: "succeeded" | "failed" | "cancelled";
					settledAt?: string;
					summary?: string;
				},
			) => {
				const fake = db as { workAttemptRows: WorkAttemptRow[] };
				const attempt = fake.workAttemptRows.find(
					(row) => row.id === input.attemptId,
				);
				if (!attempt)
					throw new Error(`Missing Work attempt ${input.attemptId}`);
				attempt.outcome = input.outcome;
				attempt.runtimeState =
					input.outcome === "succeeded"
						? "finished"
						: input.outcome === "failed"
							? "failed"
							: "cancelled";
				attempt.finishedAt = input.settledAt ?? new Date().toISOString();
				attempt.summary = input.summary ?? null;
				attempt.version += 1;
				return attempt;
			},
		),
	};
});

vi.mock("@tedix/db/queries/work-items/evidence", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/work-items/evidence")
	>()),
	submitWorkItemEvidence: vi.fn(
		async (db: unknown, input: Record<string, any>) => {
			const fake = db as { workEvidenceRows: Array<Record<string, any>> };
			const evidence = {
				id: crypto.randomUUID(),
				attemptId: input.attemptId ?? null,
				claimKey: input.claimKey,
				digest: input.digest ?? null,
				disposition: "pending",
				kind: input.kind,
				metadata: input.metadata ?? {},
				uri: input.uri,
				workItemId: input.workItemId,
			};
			fake.workEvidenceRows.push(evidence);
			return evidence;
		},
	),
}));

vi.mock("@tedix/db/queries/work-items/projections", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/work-items/projections")
	>()),
	listOrgWorkEvidence: vi.fn(
		async (db: unknown, input: Record<string, any>) => {
			const fake = db as {
				workEvidenceRows: Array<Record<string, any>>;
				workItemRows: WorkItemRow[];
			};
			return {
				data: fake.workEvidenceRows
					.filter(
						(row) =>
							row.workItemId === input.workItemId &&
							row.attemptId === input.attemptId,
					)
					.map((evidence) => ({
						evidence,
						workItem: fake.workItemRows.find(
							(item) => item.id === evidence.workItemId,
						),
					})),
				nextCursor: null,
				observedAt: new Date().toISOString(),
			};
		},
	),
}));

vi.mock("@tedix/db/queries/work-items/crud", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/work-items/crud")
	>()),
	completeWorkItem: vi.fn(async (db: unknown, input: Record<string, any>) => {
		const fake = db as { workItemRows: WorkItemRow[] };
		const item = fake.workItemRows.find((row) => row.id === input.workItemId);
		if (!item) throw new Error(`Missing Work Item ${input.workItemId}`);
		item.disposition = "completed";
		return item;
	}),
}));

describe("kernel enqueue response budget", () => {
	it("charges pre-DO work against the total in-band budget", () => {
		expect(remainingKernelTurnBudgetMs(1_000, 4_500, 10_000)).toBe(6_500);
		expect(remainingKernelTurnBudgetMs(1_000, 12_000, 10_000)).toBe(0);
	});

	it("does not create extra budget when the clock moves backwards", () => {
		expect(remainingKernelTurnBudgetMs(2_000, 1_000, 10_000)).toBe(10_000);
	});

	it("defaults to a 25s inline budget so typical 13-23s turns answer in-band", () => {
		expect(remainingKernelTurnBudgetMs(0, 0)).toBe(25_000);
		expect(remainingKernelTurnBudgetMs(0, 20_000)).toBe(5_000);
	});
});

describe("kernel DO integration (enqueueMessage kernel path)", () => {
	afterEach(() => {
		kernelRuntimeTestHooks.setKernelForTest(null);
		kernelRuntimeTestHooks.setKernelTurnSoftDeadlineForTest(null);
	});

	/** Real-timer tick so post-ack microtasks/timers settle (no fake timers). */
	function flushAsync(ms = 10) {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	/** Minimal contract-valid result the fake DO stub returns. */
	function doTurnResult(runId: string) {
		const at = "2026-06-10T08:00:00.000Z";
		return {
			idempotencyKey: runId,
			conversationId: "home:do",
			status: "needs_delegation" as const,
			run: {
				id: runId,
				organizationId: ORG_ID,
				conversationId: "home:do",
				status: "completed" as const,
				inputMessageId: `${runId}:input`,
				outputMessageId: `${runId}:assistant`,
				delegatedTediId: null,
				childRunId: null,
				startedAt: at,
				completedAt: at,
				createdAt: at,
				updatedAt: at,
				metadata: { source: "kernel.processTurn" },
			},
			homePlan: undefined,
			assistantMessage: {
				id: `${runId}:assistant`,
				organizationId: ORG_ID,
				conversationId: "home:do",
				runId,
				role: "assistant" as const,
				status: "completed" as const,
				content: "FROM THE DO",
				createdAt: at,
				startedAt: at,
				completedAt: at,
			},
			error: undefined,
		};
	}

	it("routes kernel-eligible turns through KERNEL.processTurn and returns its result verbatim", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const processTurn = vi.fn(
			async (input: { runId: string; organizationId: string }) =>
				doTurnResult(input.runId),
		);
		const idFromName = vi.fn(() => "do-id");
		(context.env as Record<string, unknown>).KERNEL = {
			idFromName,
			get: vi.fn(() => ({ processTurn })),
		};
		const inlineKernel = vi.fn(async () => null);
		kernelRuntimeTestHooks.setKernelForTest(inlineKernel);

		const client = createKernelRuntimeClient(context);
		const result = await client.enqueueMessage({
			conversationId: "home:do",
			content: "what changed today?",
			idempotencyKey: "home-do-success-1",
		});

		// DO keyed by org id; turn input carries the persist-first identity.
		expect(idFromName).toHaveBeenCalledWith(ORG_ID);
		expect(processTurn).toHaveBeenCalledTimes(1);
		const turnInput = processTurn.mock.calls[0]?.[0] as {
			runId: string;
			userMessageId: string;
			content: string;
		};
		expect(turnInput.runId).toBe("home-do-success-1");
		expect(turnInput.userMessageId).toBe("home-do-success-1:input");
		expect(turnInput.content).toBe("what changed today?");
		// Do result returned verbatim; inline turn body did not run.
		expect(result.assistantMessage?.content).toBe("FROM THE DO");
		expect(inlineKernel).not.toHaveBeenCalled();
		// Persist-first inserts stayed in enqueueMessage (run row durable
		// before the DO call) — the fake DO never wrote anything.
		expect(db.runs).toHaveLength(1);
		expect(db.runs[0]?.id).toBe("home-do-success-1");
		expect(db.runs[0]?.status).toBe("running");
	});

	it("lands the ingress rows in one batch and skips the index bump on replay", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const batch = vi.spyOn(db, "batch");
		(context.env as Record<string, unknown>).KERNEL = {
			idFromName: vi.fn(() => "do-id"),
			get: vi.fn(() => ({
				processTurn: vi.fn(
					async (input: { runId: string; organizationId: string }) =>
						doTurnResult(input.runId),
				),
			})),
		};
		kernelRuntimeTestHooks.setKernelForTest(vi.fn(async () => null));

		const client = createKernelRuntimeClient(context);
		await client.enqueueMessage({
			conversationId: "home:batched",
			content: "what changed today?",
			idempotencyKey: "home-batched-1",
		});

		// First delivery: conversation-index bump + message.received +
		// run.started + run row, one D1 batch.
		expect(batch).toHaveBeenCalledTimes(1);
		expect(batch.mock.calls[0]?.[0]).toHaveLength(4);
		// The ledger's submission.admitted lands after the batch.
		const ingress = db.events.filter(
			(event) => event.runId === "home-batched-1",
		);
		expect(ingress.map((event) => event.kind)).toEqual([
			"message.received",
			"run.started",
			"submission.admitted",
		]);
		expect(ingress[1]?.causeEventId).toBe(ingress[0]?.id);
		expect(db.runs.map((run) => run.id)).toEqual(["home-batched-1"]);
		const indexRows = db.conversationIndexRows.filter(
			(row) => row.conversationId === "home:batched",
		);
		expect(indexRows).toHaveLength(1);
		expect(indexRows[0]?.messageCount).toBe(1);

		// Replay of the same idempotency key: the probe finds the stored
		// run.started cause, so the batch carries no index bump and nothing is
		// written twice.
		await client.enqueueMessage({
			conversationId: "home:batched",
			content: "what changed today?",
			idempotencyKey: "home-batched-1",
		});
		expect(batch).toHaveBeenCalledTimes(2);
		expect(batch.mock.calls[1]?.[0]).toHaveLength(3);
		expect(
			db.events.filter((event) => event.runId === "home-batched-1"),
		).toHaveLength(3);
		expect(db.runs).toHaveLength(1);
		expect(
			db.conversationIndexRows.filter(
				(row) => row.conversationId === "home:batched",
			),
		).toHaveLength(1);
	});

	it("issues the governance, allowlist and replay-probe reads together", async () => {
		const db = createKernelRuntimeDb({
			policyPackRows: [
				{
					id: "pack-1",
					definition: { governancePolicy: { approvalTtlHours: 12 } },
				} as unknown as PolicyPackRow,
			],
		});
		const context = createContext(db);
		(context.env as Record<string, unknown>).KERNEL = {
			idFromName: vi.fn(() => "do-id"),
			get: vi.fn(() => ({
				processTurn: vi.fn(
					async (input: { runId: string; organizationId: string }) =>
						doTurnResult(input.runId),
				),
			})),
		};
		kernelRuntimeTestHooks.setKernelForTest(vi.fn(async () => null));

		// Hold the governance-policy read open and record every select issued
		// while it is pending: the allowlist (run metadata) and replay-probe
		// (event by id) reads must already be in flight — they used to wait
		// for it in series.
		let releasePolicy: (() => void) | null = null;
		const policyGate = new Promise<void>((resolve) => {
			releasePolicy = resolve;
		});
		const issuedWhileHeld: unknown[] = [];
		let held = false;
		const originalSelect = db.select.bind(db);
		db.select = ((selection?: Record<string, unknown>) => {
			const builder = originalSelect(selection);
			const from = builder.from.bind(builder);
			builder.from = (table: unknown) => {
				const result = from(table);
				if (table === policyPacks && !held) {
					held = true;
					const then = result.then.bind(result);
					result.then = ((onfulfilled, onrejected) =>
						policyGate.then(() =>
							then(onfulfilled, onrejected),
						)) as typeof result.then;
				} else if (held) {
					issuedWhileHeld.push(table);
				}
				return result;
			};
			return builder;
		}) as typeof db.select;

		const client = createKernelRuntimeClient(context);
		const pending = client.enqueueMessage({
			conversationId: "home:parallel",
			content: "what changed today?",
			idempotencyKey: "home-parallel-1",
		});
		for (let tick = 0; tick < 20; tick += 1)
			await new Promise((resolve) => setTimeout(resolve, 0));
		expect(held).toBe(true);
		expect(issuedWhileHeld).toContain(kernelRuntimeRuns);
		expect(issuedWhileHeld).toContain(kernelRuntimeEvents);
		releasePolicy?.();
		await pending;
		expect(db.runs.map((run) => run.id)).toEqual(["home-parallel-1"]);
	});

	it("acks immediately when the DO returns the async-dispatch sentinel (KERNEL_ASYNC_PLANNER)", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		// processTurn returns the async sentinel: under KERNEL_ASYNC_PLANNER the DO
		// scheduled the planner off its turn body instead of running it inline.
		const processTurn = vi.fn(async () => ({ kernelAsyncDispatched: true }));
		(context.env as Record<string, unknown>).KERNEL = {
			idFromName: vi.fn(() => "do-id"),
			get: vi.fn(() => ({ processTurn })),
		};
		const inlineKernel = vi.fn(async () => null);
		kernelRuntimeTestHooks.setKernelForTest(inlineKernel);

		const client = createKernelRuntimeClient(context);
		const result = await client.enqueueMessage({
			conversationId: "home:do",
			content: "dump idea one",
			idempotencyKey: "home-async-1",
		});

		expect(processTurn).toHaveBeenCalledTimes(1);
		// Ack path: the run id is the real persist-first run, status queued, no
		// answer yet (the caller polls task.id), and the inline body never ran.
		expect(result.status).toBe("queued");
		expect(result.run.id).toBe("home-async-1");
		expect(result.run.status).toBe("running");
		expect(result.assistantMessage).toBeUndefined();
		expect(inlineKernel).not.toHaveBeenCalled();
		// Persist-first run row durable before the DO call.
		expect(db.runs).toHaveLength(1);
		expect(db.runs[0]?.id).toBe("home-async-1");
	});

	it("falls back to the inline turn body when the DO stub throws", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const processTurn = vi.fn(async () => {
			throw new Error("durable object unavailable");
		});
		(context.env as Record<string, unknown>).KERNEL = {
			idFromName: vi.fn(() => "do-id"),
			get: vi.fn(() => ({ processTurn })),
		};
		const inlineKernel = vi.fn(async () => ({
			assistantContent: "INLINE FALLBACK",
			route: {
				routeKind: "answer_directly" as const,
				rationale: "Direct answer.",
				risk: "low" as const,
				confidence: 0.9,
			},
		}));
		kernelRuntimeTestHooks.setKernelForTest(
			inlineKernel as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelForTest
			>[0],
		);

		const client = createKernelRuntimeClient(context);
		const result = await client.enqueueMessage({
			conversationId: "home:do",
			content: "what changed today?",
			idempotencyKey: "home-do-fallback-1",
		});

		expect(processTurn).toHaveBeenCalledTimes(1);
		expect(inlineKernel).toHaveBeenCalledTimes(1);
		expect(result.assistantMessage?.content).toBe("INLINE FALLBACK");
		// Inline turn body completed the run (running → completed patch).
		expect(db.runs[0]?.status).toBe("completed");
		const inlineRunMetadata = db.runs[0]?.metadata as
			| Record<string, unknown>
			| undefined;
		expect(inlineRunMetadata).toBeDefined();
		expect(inlineRunMetadata?.kernelRoute).toMatchObject({
			routeKind: "answer_directly",
		});
	});

	it("returns the soft-deadline ack (real run id, contract-valid status) when the DO turn outlives the deadline", async () => {
		kernelRuntimeTestHooks.setKernelTurnSoftDeadlineForTest(25);
		const db = createKernelRuntimeDb();
		const context = createContext(db) as BaseContext & {
			waitUntilPromises: Promise<unknown>[];
		};
		let resolveTurn!: (value: ReturnType<typeof doTurnResult>) => void;
		const processTurn = vi.fn(
			() =>
				new Promise<ReturnType<typeof doTurnResult>>((resolve) => {
					resolveTurn = resolve;
				}),
		);
		(context.env as Record<string, unknown>).KERNEL = {
			idFromName: vi.fn(() => "do-id"),
			get: vi.fn(() => ({ processTurn })),
		};
		const inlineKernel = vi.fn(async () => null);
		kernelRuntimeTestHooks.setKernelForTest(inlineKernel);

		const client = createKernelRuntimeClient(context);
		const result = await client.enqueueMessage({
			conversationId: "home:do",
			content: "slow turn that outlives the soft deadline",
			idempotencyKey: "home-do-deadline-1",
		});

		// Ack shape: top-level status "queued" (the output enum has no
		// "running"), run still "running" with the real run id so the MCP task
		// linkage (task.id = run.id) attaches, kernel-owned metadata null (the
		// DO patches kernelRoute/kernelEvidence on completion), no assistantMessage.
		expect(result.status).toBe("queued");
		expect(result.run.id).toBe("home-do-deadline-1");
		expect(result.run.status).toBe("running");
		expect(result.run.completedAt).toBeNull();
		expect(result.run.metadata).toMatchObject({
			kernelRoute: null,
			kernelEvidence: null,
		});
		expect(result.run.progress?.label).toBe("Running");
		expect(result.assistantMessage).toBeUndefined();
		// Persist-first state at ack time: the run row is durable and still
		// "running" (the fake DO never wrote anything).
		expect(db.runs).toHaveLength(1);
		expect(db.runs[0]?.id).toBe("home-do-deadline-1");
		expect(db.runs[0]?.status).toBe("running");
		expect(inlineKernel).not.toHaveBeenCalled();

		// The dangling stub promise resolving after the ack does nothing: no
		// inline re-run, no extra writes — the DO owns the turn now.
		const eventCountAtAck = db.events.length;
		resolveTurn(doTurnResult("home-do-deadline-1"));
		await Promise.all(context.waitUntilPromises);
		await flushAsync();
		expect(inlineKernel).not.toHaveBeenCalled();
		expect(db.events).toHaveLength(eventCountAtAck);
		expect(db.runs[0]?.status).toBe("running");
	});

	it.each(["running", "completed", "canceled", "requires_approval"] as const)(
		"settles a late DO rejection only while the run is active (%s), without replay",
		async (statusAtRejection) => {
			kernelRuntimeTestHooks.setKernelTurnSoftDeadlineForTest(25);
			const db = createKernelRuntimeDb();
			const context = createContext(db) as BaseContext & {
				waitUntilPromises: Promise<unknown>[];
			};
			let rejectTurn!: (reason: unknown) => void;
			const processTurn = vi.fn(
				() =>
					new Promise<ReturnType<typeof doTurnResult>>((_resolve, reject) => {
						rejectTurn = reject;
					}),
			);
			(context.env as Record<string, unknown>).KERNEL = {
				idFromName: vi.fn(() => "do-id"),
				get: vi.fn(() => ({ processTurn })),
			};
			const inlineKernel = vi.fn(async () => null);
			kernelRuntimeTestHooks.setKernelForTest(inlineKernel);

			const client = createKernelRuntimeClient(context);
			const result = await client.enqueueMessage({
				conversationId: "home:do",
				content: "slow turn whose DO later fails",
				idempotencyKey: "home-do-late-error-1",
			});

			expect(result.status).toBe("queued");
			expect(result.run.id).toBe("home-do-late-error-1");
			expect(inlineKernel).not.toHaveBeenCalled();
			const eventCountAtAck = db.events.length;
			db.runs[0]!.status = statusAtRejection;

			// A late rejection (after the deadline ack) must not trigger the inline
			// fallback — the ack already told the caller to poll, and the turn may
			// have partially completed under the DO. Report interruption without replay.
			rejectTurn(new Error("late durable object failure"));
			await Promise.all(context.waitUntilPromises);
			await flushAsync();
			expect(inlineKernel).not.toHaveBeenCalled();
			expect(processTurn).toHaveBeenCalledTimes(1);
			expect(db.runs).toHaveLength(1);
			if (statusAtRejection === "running") {
				expect(db.runs[0]?.status).toBe("failed");
				expect(db.runs[0]?.progressLabel).toBe("Interrupted");
				expect(
					db.events.slice(eventCountAtAck).map((event) => event.kind),
				).toContain("run.failed");
				expect(
					db.events.slice(eventCountAtAck).map((event) => event.kind),
				).toContain("message.completed");
				expect(db.submissionSettleCalls).toContainEqual({
					submissionId: "sub:home-do-late-error-1",
					outcome: "failed",
				});
				expect(JSON.stringify(db.events.slice(eventCountAtAck))).not.toContain(
					"late durable object failure",
				);
			} else {
				expect(db.events).toHaveLength(eventCountAtAck);
				expect(db.runs[0]?.status).toBe(statusAtRejection);
				expect(db.submissionSettleCalls).toHaveLength(0);
			}
		},
	);
});

describe("governance policy: fan-out cap and approval TTL", () => {
	afterEach(() => {
		kernelRuntimeTestHooks.setDelegateRunnerForTest(null);
		kernelRuntimeTestHooks.setKernelForTest(null);
	});

	it("blocks auto-dispatch when maxDelegationsPerTurn=1 (dispatch tool counts as the 1 slot)", async () => {
		// maxDelegationsPerTurn=1 means the dispatch tool itself fills the only slot;
		// no child spawns are allowed. This is the kill-switch equivalent of a
		// spawn_bounds.max_dispatches_per_turn cap enforced with the spawn
		// tool counted. The turn must fail rather than silently drop the dispatch.
		const db = createKernelRuntimeDb({
			policyPackRows: [
				{
					definition: {
						governancePolicy: { maxDelegationsPerTurn: 1 },
					},
					// status is checked via where clause; mock returns all rows so include it
					status: "active",
				} as PolicyPackRow,
			],
		});
		const context = createContext(db, { userSub: "operator-1" });
		const client = createKernelRuntimeClient(context);
		const delegateRunner = vi.fn(async (input: { childRunId: string }) => ({
			childConversationId: "agent:main:main",
			childRunId: input.childRunId,
			status: "queued" as const,
		}));
		kernelRuntimeTestHooks.setDelegateRunnerForTest(delegateRunner);
		kernelRuntimeTestHooks.setKernelForTest(
			vi.fn(async () => ({
				assistantContent: "Dispatching CPO.",
				route: {
					routeKind: "delegate_tedi" as const,
					rationale: "CPO owns this.",
					risk: "low" as const,
					confidence: 0.95,
					effortClass: "embodied" as const,
					answer: "Delegating to CPO.",
					targetTediId: "tedi-cpo",
					targetTediLabel: "CPO",
					toolIntent: null,
					workflowHint: null,
					clarifyingQuestion: null,
					evidenceExpectation: null,
				},
				delegation: {
					workOrder: {
						objective: "Handle task.",
						executionRequirement: NATIVE_EXECUTION_REQUIREMENT,
						outputContract: "Return result.",
						toolGuidance: [],
						boundaries: [],
						sourceContent: "Task content.",
						targetTediId: "tedi-cpo",
						targetTediLabel: "CPO",
					},
					decision: {
						canAutoDispatch: true,
						mode: "auto",
						reason: "authorized",
					},
				},
			})) as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelForTest
			>[0],
		);

		const result = await client.enqueueMessage({
			conversationId: "home:test",
			content: "Ask CPO to handle this task.",
			idempotencyKey: "fan-out-blocked-1",
		});

		// The dispatch must be blocked (fail-closed, not silently dropped).
		expect(delegateRunner).not.toHaveBeenCalled();
		expect(result.status).toBe("failed");
		expect(result.run.status).toBe("failed");
		expect(db.runs[0]?.status).toBe("failed");
		// Error recorded on the auto-dispatch metadata, with the spawn-bound
		// counting + "fan out in waves" guidance (change 2).
		expect(db.runs[0]?.metadata).toMatchObject({
			homeAutoDispatch: {
				status: "failed",
				error: expect.stringContaining("fan-out cap reached"),
			},
		});
		const capError = (
			db.runs[0]?.metadata as {
				homeAutoDispatch?: { error?: string };
			}
		)?.homeAutoDispatch?.error;
		expect(capError).toContain("counts the dispatch spawn itself");
		expect(capError).toContain("fan out in waves");
	});

	it("boot_unavailable verdict makes NO dispatch call, NO approval row, and persists the refusal", async () => {
		// Change 1 turn-level proof: a cold embodied target yields boot_unavailable.
		// The turn must refuse — never enqueue a child (the cold-503 failure) and
		// never open an approval card — but still record the refusal evidence.
		const db = createKernelRuntimeDb();
		const context = createContext(db, { userSub: "operator-1" });
		const client = createKernelRuntimeClient(context);
		const delegateRunner = vi.fn(async (input: { childRunId: string }) => ({
			childConversationId: "agent:main:main",
			childRunId: input.childRunId,
			status: "queued" as const,
		}));
		kernelRuntimeTestHooks.setDelegateRunnerForTest(delegateRunner);
		kernelRuntimeTestHooks.setKernelForTest(
			vi.fn(async () => ({
				assistantContent: "CPO's workstation is cold.",
				route: {
					routeKind: "delegate_tedi" as const,
					rationale: "CPO owns this.",
					risk: "low" as const,
					confidence: 0.95,
					effortClass: "embodied" as const,
					answer: null,
					targetTediId: "tedi-cpo",
					targetTediLabel: "CPO",
					toolIntent: null,
					workflowHint: null,
					clarifyingQuestion: null,
					evidenceExpectation: null,
				},
				delegation: {
					workOrder: {
						objective: "Handle task.",
						executionRequirement: WORKSTATION_EXECUTION_REQUIREMENT,
						outputContract: "Return result.",
						toolGuidance: [],
						boundaries: [],
						sourceContent: "Task content.",
						targetTediId: "tedi-cpo",
						targetTediLabel: "CPO",
					},
					decision: {
						canAutoDispatch: false,
						mode: "boot_unavailable",
						reason:
							"target body is cold — no running body or warm workstation lease; refusing dispatch",
					},
				},
			})) as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelForTest
			>[0],
		);

		await client.enqueueMessage({
			conversationId: "home:test",
			content: "Ask CPO to handle this task.",
			idempotencyKey: "boot-unavailable-1",
		});

		// No child dispatch was attempted (the whole point of boot_unavailable).
		expect(delegateRunner).not.toHaveBeenCalled();
		// No approval card opened — boot_unavailable is a refusal, not a decision
		// request.
		expect(db.approvals).toHaveLength(0);
		// The refusal is persisted as durable delegation evidence on the run.
		const meta = db.runs[0]?.metadata as {
			homeDelegation?: { decision?: { mode?: string; reason?: string } };
			homeAutoDispatch?: unknown;
		};
		expect(meta?.homeDelegation?.decision?.mode).toBe("boot_unavailable");
		expect(meta?.homeDelegation?.decision?.reason).toContain("cold");
		// No auto-dispatch metadata was written (no spawn was made or failed).
		expect(meta?.homeAutoDispatch ?? null).toBeNull();
	});

	it("allows auto-dispatch when maxDelegationsPerTurn=2 (cap covers the spawn tool + 1 child)", async () => {
		// cap=2: dispatch tool = 1, one child = 1 → total 2, within budget.
		const db = createKernelRuntimeDb({
			policyPackRows: [
				{
					definition: {
						governancePolicy: { maxDelegationsPerTurn: 2 },
					},
					status: "active",
				} as PolicyPackRow,
			],
		});
		const context = createContext(db, { userSub: "operator-1" });
		const client = createKernelRuntimeClient(context);
		const delegateRunner = vi.fn(async (input: { childRunId: string }) => ({
			childConversationId: "agent:main:main",
			childRunId: input.childRunId,
			status: "queued" as const,
		}));
		kernelRuntimeTestHooks.setDelegateRunnerForTest(delegateRunner);
		kernelRuntimeTestHooks.setKernelForTest(
			vi.fn(async () => ({
				assistantContent: "Dispatching CPO.",
				route: {
					routeKind: "delegate_tedi" as const,
					rationale: "CPO owns this.",
					risk: "low" as const,
					confidence: 0.95,
					effortClass: "embodied" as const,
					answer: "Delegating to CPO.",
					targetTediId: "tedi-cpo",
					targetTediLabel: "CPO",
					toolIntent: null,
					workflowHint: null,
					clarifyingQuestion: null,
					evidenceExpectation: null,
				},
				delegation: {
					workOrder: {
						objective: "Handle task.",
						executionRequirement: NATIVE_EXECUTION_REQUIREMENT,
						outputContract: "Return result.",
						toolGuidance: [],
						boundaries: [],
						sourceContent: "Task content.",
						targetTediId: "tedi-cpo",
						targetTediLabel: "CPO",
					},
					decision: {
						canAutoDispatch: true,
						mode: "auto",
						reason: "authorized",
					},
				},
			})) as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelForTest
			>[0],
		);

		const result = await client.enqueueMessage({
			conversationId: "home:test",
			content: "Ask CPO to handle this.",
			idempotencyKey: "fan-out-allowed-1",
		});

		expect(delegateRunner).toHaveBeenCalledTimes(1);
		expect(result.status).toBe("queued");
		expect(result.run.status).toBe("queued");
	});

	it("blocks plan assignment dispatch when selected assignments exceed cap budget", async () => {
		// maxDelegationsPerTurn=2 → allows 1 child dispatch (cap - 1 = 1 for approval action).
		// A plan with 2 assignments should be blocked.
		const db = createKernelRuntimeDb({
			policyPackRows: [
				{
					definition: {
						governancePolicy: { maxDelegationsPerTurn: 2 },
					},
					status: "active",
				} as PolicyPackRow,
			],
		});
		const context = createContext(db);
		const client = createKernelRuntimeClient(context);
		// Seed a proposed run with 2-assignment Home plan.
		const proposed = await client.enqueueMessage({
			conversationId: "home:test",
			content:
				"Plan this across CPO and Echo: CPO owns the launch plan while Echo validates the data.",
			idempotencyKey: "fan-out-plan-cap-1",
		});

		expect(proposed.homePlan?.assignments).toHaveLength(2);

		// Attempting to dispatch both assignments (2) with cap=2 allows budget of 1
		// child (cap - 1 approval action = 1). 2 > 1 → should throw.
		await expect(
			client.approvePlanAssignments({
				runId: "fan-out-plan-cap-1",
				approvalNote: "trying to dispatch 2 assignments past cap",
			}),
		).rejects.toThrow(/fan-out cap reached/);
	});

	it("allows plan assignment dispatch within cap budget", async () => {
		// maxDelegationsPerTurn=3 → allows 2 child dispatches (cap - 1 = 2).
		// A plan with 2 assignments should succeed.
		const db = createKernelRuntimeDb({
			policyPackRows: [
				{
					definition: {
						governancePolicy: { maxDelegationsPerTurn: 3 },
					},
					status: "active",
				} as PolicyPackRow,
			],
		});
		const context = createContext(db);
		const client = createKernelRuntimeClient(context);
		const delegateRunner = vi.fn(async (input: { childRunId: string }) => ({
			childConversationId: "agent:main:main",
			childRunId: `child:${input.childRunId}`,
			status: "queued" as const,
		}));
		kernelRuntimeTestHooks.setDelegateRunnerForTest(delegateRunner);

		const proposed = await client.enqueueMessage({
			conversationId: "home:test",
			content:
				"Plan this across CPO and Echo: CPO owns the launch plan while Echo validates the data.",
			idempotencyKey: "fan-out-plan-ok-1",
		});

		expect(proposed.homePlan?.assignments).toHaveLength(2);

		const approved = await client.approvePlanAssignments({
			runId: "fan-out-plan-ok-1",
			approvalNote: "Dispatching 2 assignments within cap=3",
		});

		await Promise.all(context.waitUntilPromises);
		expect(approved.assignments).toHaveLength(2);
		expect(approved.assignments.every((a) => a.status === "queued")).toBe(true);
		expect(delegateRunner).toHaveBeenCalledTimes(2);
	});

	it("approval TTL respects configurable window from governance policy", async () => {
		// approvalTtlHours=48 means the write approval expires 48h from creation.
		const db = createKernelRuntimeDb({
			policyPackRows: [
				{
					definition: {
						governancePolicy: { approvalTtlHours: 48 },
					},
					status: "active",
				} as PolicyPackRow,
			],
		});
		const context = createContext(db, { userSub: "operator-1" });
		const client = createKernelRuntimeClient(context);

		// Stub a propose_tool_write route to trigger write approval creation.
		kernelRuntimeTestHooks.setKernelForTest(
			vi.fn(async () => ({
				assistantContent: "I'll update the invoice.",
				route: {
					routeKind: "propose_tool_write" as const,
					rationale: "Update invoice 42.",
					risk: "medium" as const,
					confidence: 0.85,
					effortClass: "cognitive" as const,
					answer: "Will update invoice 42 on globex.",
					targetTediId: null,
					targetTediLabel: null,
					toolIntent: {
						appSlug: "globex",
						capability: "update_invoice",
						connectionStatus: "connected" as const,
					},
					workflowHint: null,
					clarifyingQuestion: null,
					evidenceExpectation: null,
					writeIntent: {
						appSlug: "globex",
						toolName: "update_invoice",
						args: { invoiceId: "42", status: "paid" },
						rationale: "Marking invoice 42 as paid.",
					},
				},
			})) as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelForTest
			>[0],
		);

		// Stub the write proposal planner to return a concrete proposal.
		kernelRuntimeTestHooks.setKernelWriteProposalPlannerForTest(
			vi.fn(async () => ({
				appSlug: "globex",
				toolName: "update_invoice",
				args: { invoiceId: "42", status: "paid" },
				rationale: "Marking invoice 42 as paid.",
			})),
		);

		// Need an anchor tedi for write approval. Add one to the tedi rows.
		db.tediRows.push({
			runtimeStatus: null,
			displayName: "Anchor",
			id: "tedi-anchor",
			name: "Anchor",
			organizationId: ORG_ID,
			runtimeKind: "agent",
			slug: "anchor",
		});

		const result = await client.enqueueMessage({
			conversationId: "home:test",
			content: "Update invoice 42 to paid on globex.",
			idempotencyKey: "approval-ttl-test-1",
		});

		// The run should be parked for approval.
		expect(result.status).toBe("requires_approval");

		// Check that the approval row has a 48-hour expiry window.
		const approvalRow = db.approvals.find(
			(approval) => approval.actionType === "home.tool_write",
		);
		expect(approvalRow).toBeDefined();
		if (approvalRow) {
			const created = new Date(approvalRow.createdAt).getTime();
			const expires = new Date(approvalRow.expiresAt).getTime();
			const windowHours = (expires - created) / (1000 * 60 * 60);
			// Configurable 48-hour window (not the default 24h).
			expect(windowHours).toBeCloseTo(48, 0);
		}
	});
});

describe("home plan generalization (kernel-evals plan.multi_tedi_work_items)", () => {
	const target = (slug: string, displayName: string): HomePlanningTarget =>
		({
			displayName,
			id: `t-${slug}`,
			name: displayName,
			runtimeKind: "agent",
			runtimeState: null,
			slug,
			status: "active",
		}) as unknown as HomePlanningTarget;
	const roster = [
		target("cpo", "CPO"),
		target("cmo", "CMO"),
		target("ceo", "CEO"),
		target("research", "Research"),
	];

	it("detects a plan request without the old hardcoded CPO+Echo names", () => {
		// The original gate required both "cpo" and "echo"; now any plan-intent
		// phrasing qualifies (the >=2-named-tedis gate lives in selection).
		expect(
			detectsHomePlanningRequest("Plan and split this across the teams"),
		).toBe(true);
		expect(
			detectsHomePlanningRequest("Coordinate the rollout across two owners"),
		).toBe(true);
		expect(detectsHomePlanningRequest("What's the status of the launch?")).toBe(
			false,
		);
	});

	it("clamps a long LLM objective to the dispatch bound (plan v1)", () => {
		const short = "Review the deploy pipeline and flag release risks.";
		expect(clampPlanObjective(short)).toBe(short);
		const clamped = clampPlanObjective("x".repeat(900));
		expect(clamped.length).toBe(600);
		expect(clamped.endsWith("…")).toBe(true);
	});

	it("selects EVERY named tedi, not just CPO/Echo", () => {
		const picked = selectedHomePlanTargets({
			content:
				"Plan a launch brief: have CPO draft the product section and CMO draft go-to-market.",
			targets: roster,
		});
		expect(picked.map((t) => t.slug)).toEqual(["cpo", "cmo"]);
	});

	it("works for an arbitrary pair (CEO + Research) the old hardcode could never plan", () => {
		const picked = selectedHomePlanTargets({
			content: "Coordinate this across CEO and Research — split the analysis.",
			targets: roster,
		});
		expect(picked.map((t) => t.slug).sort()).toEqual(["ceo", "research"]);
	});

	it("declines (<2) when fewer than two tedis are named — no fabricated owners", () => {
		expect(
			selectedHomePlanTargets({
				content: "Have CPO own the whole launch.",
				targets: roster,
			}).map((t) => t.slug),
		).toEqual(["cpo"]);
		expect(
			selectedHomePlanTargets({
				content: "Plan the launch carefully.",
				targets: roster,
			}),
		).toEqual([]);
	});

	// Fix #15 — single explicitly-named target must not fan out.
	// When a single strong (slug-token) match is present, all weak-only matches
	// are suppressed so "ask the CTO to …" returns only the CTO tedi even when
	// another tedi's display-name contains an incidental prose word match.
	it("single strong target: does not fan out to weak-match tedis", () => {
		// Extend the roster with a tedi whose display-name contains "bench" — a
		// word that can appear in prose without the operator naming that tedi.
		// With the stopword addition "bench" is now filtered, so this also covers
		// the stopword fix. Add a tedi whose display-name contains "tedix" too.
		const extendedRoster = [
			...roster,
			target("bench", "Tedix Bench"), // "bench" in display-name (stopworded)
		];
		const picked = selectedHomePlanTargets({
			content: "Ask the CPO to review the deploy benchmark results.",
			targets: extendedRoster,
		});
		// "benchmark" contains "bench" but bench tedi's slug "bench" is now
		// stopworded. CPO (strong slug token "cpo") is the only match.
		expect(picked.map((t) => t.slug)).toEqual(["cpo"]);
	});

	it("single strong target: collapses fan-out when exactly one slug matches strongly", () => {
		// Build a roster where "cpo" strongly matches, but there's also a tedi
		// whose display-name is "Product Operations" — "product" might weakly match
		// the word "product" in the sentence without the operator naming that tedi.
		const mixedRoster = [...roster, target("prodops", "Product Operations")];
		const picked = selectedHomePlanTargets({
			content: "Ask the CPO to review the product roadmap.",
			targets: mixedRoster,
		});
		// "cpo" slug strongly names one target (CPO); "prodops" display-name
		// "Product Operations" may weakly match "product" in the sentence.
		// With dominance rule: only CPO is returned.
		const slugs = picked.map((t) => t.slug);
		expect(slugs).toContain("cpo");
		expect(slugs.length).toBe(1);
	});

	it("does not mistake an interview pilot for the System 1 Pilot tedi", () => {
		const extendedRoster = [
			...roster,
			target("system1-pilot", "System 1 Pilot (Workers AI 70B)"),
		];
		const picked = selectedHomePlanTargets({
			content:
				"Delegate this bounded GTM brief to CMO for a four-week interview pilot; no other tedi is needed.",
			targets: extendedRoster,
		});
		expect(picked.map((t) => t.slug)).toEqual(["cmo"]);
	});

	it("still recognizes the System 1 Pilot tedi when explicitly named", () => {
		const extendedRoster = [
			...roster,
			target("system1-pilot", "System 1 Pilot (Workers AI 70B)"),
		];
		const picked = selectedHomePlanTargets({
			content: "Plan a CMO brief and ask System 1 Pilot to review it.",
			targets: extendedRoster,
		});
		expect(picked.map((t) => t.slug)).toEqual(["cmo", "system1-pilot"]);
	});

	it("two strong targets: keeps both (no false collapse)", () => {
		const picked = selectedHomePlanTargets({
			content: "Have CPO draft the product brief and CEO review the budget.",
			targets: roster,
		});
		expect(picked.map((t) => t.slug).sort()).toEqual(["ceo", "cpo"]);
	});
});

/**
 * Local mirror of the Tedix OS consumer's `unwrapStructuredPayload`. The producer
 * cannot import the separate frontend repository, so we re-derive
 * the same accept gate the Tedix OS applies to a `Raw result: …` preview and assert
 * the emitted envelope round-trips through it — proving the delegation receipt
 * will yield a card-bearing `output` on the Tedix OS side.
 */
