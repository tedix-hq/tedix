import { HomeRunSteering } from "../../kernel/run-steering";
import { PageToolBroker } from "@tedix/chat-transport/page-tool-broker";
import { LOCAL_DEMO_PROJECT_ID } from "@tedix/auth/local-demo";
import * as kernelRequestQueries from "@tedix/db/queries/kernel-requests";
import * as kernelRequestSource from "../../kernel/request-home-source";
import { receivedKernelRequest } from "../../kernel/request-coordinator";
import {
	findWorkItemsBlockedBy,
	queryWorkItemBlockers,
} from "@tedix/db/queries/work-items/relations";
import { kernelRuntimeEvents } from "@tedix/db/schema";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { assembleHomeContext } from "./kernel/context-assembly";
import { insertKernelRuntimeEvent } from "./kernel/run-store";
import { normalizeHomeRunRecord } from "./kernel/run-store-normalization";
import { homeRuntimeEventId } from "@tedix/api-contract/utils/runtime-events";
import { readChildRunStatuses } from "./kernel-runtime/run-reads-streams";
import { kernelRuntimeTestHooks } from "./kernel-runtime/policy-normalization";
import { setKernelToolResultRetainerForTest } from "./kernel/write-approval-settlement";

import {
	ORG_ID,
	WORKSTATION_EXECUTION_REQUIREMENT,
	type WorkItemRow,
	type WorkAttemptRow,
	normalizeKernelConversationInsert,
	normalizeKernelRuntimeEventInsert,
	normalizeKernelRuntimeRunInsert,
	normalizeWorkItemInsert,
	runningWorkAttempt,
	isRuntimeEventSource,
	createKernelRuntimeDb,
	createMissingKernelRuntimeTableDb,
	createContext,
	createKernelRuntimeClient,
	childRuntimeEvent,
	grantRow,
	planAssignmentSeed,
	seedDependencyPlanRun,
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

describe("kernel runtime router", () => {
	it("maps invalid causal event references to CONFLICT", async () => {
		const db = createKernelRuntimeDb();
		await expect(
			insertKernelRuntimeEvent(createContext(db), {
				id: "causal-child",
				organizationId: ORG_ID,
				kind: "run.started",
				conversationId: "home:causal",
				causeEventId: "missing-cause",
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});
	it("refuses explicit local delegation before creating execution state", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(
			createContext(db, {
				env: {
					TEDIX_LOCAL_DEMO_ENABLED: "true",
					DESCOPE_PROJECT_ID: LOCAL_DEMO_PROJECT_ID,
				},
			}),
		);
		const delegateRunner = vi.fn();
		kernelRuntimeTestHooks.setDelegateRunnerForTest(delegateRunner);
		await expect(
			client.enqueueMessage({
				content: "Review the supplier proposal",
				delegateToTediId: "tedi-cpo",
				idempotencyKey: "local-delegation",
			}),
		).rejects.toThrow("This local installation does not run tedis");
		expect(delegateRunner).not.toHaveBeenCalled();
		expect(db.approvals).toHaveLength(0);
		expect(db.workItemRows).toHaveLength(0);
		expect(db.runs).toHaveLength(0);
		expect(db.approvals).toHaveLength(0);
		expect(db.events).toHaveLength(0);
	});

	afterEach(() => {
		vi.mocked(kernelRequestQueries.getHomeKernelRequest).mockRestore?.();
		vi.mocked(kernelRequestSource.readKernelRequestPolicy).mockRestore?.();
		vi.mocked(kernelRequestSource.reconcileHomeKernelRequest).mockRestore?.();
		kernelRuntimeTestHooks.setDelegateRunnerForTest(null);
		kernelRuntimeTestHooks.setChildSteerForwarderForTest(null);
		kernelRuntimeTestHooks.setChildStopperForTest(null);
		kernelRuntimeTestHooks.setDoTurnCancelerForTest(null);
		kernelRuntimeTestHooks.setKernelForTest(null);
		kernelRuntimeTestHooks.setKernelWriteProposalPlannerForTest(null);
		kernelRuntimeTestHooks.setKernelWriteExecutorForTest(null);
		setKernelToolResultRetainerForTest(null);
	});

	it("preserves org-wide Home access until a conversation has explicit grants", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));

		await expect(
			client.enqueueMessage({
				conversationId: "home:open",
				content: "org-wide by default",
				idempotencyKey: "grant-open-1",
			}),
		).resolves.toMatchObject({
			conversationId: "home:open",
		});
	});

	it("replays an authorized delegated child from canonical tedi runtime events", async () => {
		const db = createKernelRuntimeDb();
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-child-stream-1",
				organizationId: ORG_ID,
				conversationId: "home:child-stream",
				status: "running",
				delegatedTediId: "tedi-cto",
				childRunId: "child-stream-1",
			}),
		);
		db.runtimeEvents.push(
			childRuntimeEvent({
				createdAt: "2026-07-18T10:00:00.000Z",
				id: "child-tool",
				kind: "tool.completed",
				payload: { name: "work.list_work_items" },
				runId: "child-stream-1",
				tediId: "tedi-cto",
				toolCallId: "tool-call-1",
			}),
			childRuntimeEvent({
				approvalRequestId: "approval-1",
				createdAt: "2026-07-18T10:00:01.000Z",
				id: "child-approval",
				kind: "approval.requested",
				payload: { description: "Approve the write" },
				runId: "child-stream-1",
				tediId: "tedi-cto",
			}),
			childRuntimeEvent({
				createdAt: "2026-07-18T10:00:02.000Z",
				id: "child-terminal",
				kind: "run.completed",
				messageId: "message-1",
				runId: "child-stream-1",
				tediId: "tedi-cto",
			}),
		);

		const client = createKernelRuntimeClient(createContext(db));
		const result = await client.readRunEvents({
			runId: "home-child-stream-1",
			childRunId: "child-stream-1",
			delegatedTediId: "tedi-cto",
			offset: 0,
		});

		expect(result.events.map((event) => event.id)).toEqual([
			"child-tool",
			"child-approval",
			"child-terminal",
		]);
		expect(result.events[0]).toMatchObject({ toolCallId: "tool-call-1" });
		expect(result.events[1]).toMatchObject({
			approvalRequestId: "approval-1",
		});
		expect(result.events[2]).toMatchObject({ messageId: "message-1" });
		expect(result.stream).toMatchObject({
			streamId: "home:home-child-stream-1:child:child-stream-1",
			offset: 0,
			nextOffset: 3,
			closed: true,
			terminalEventId: "child-terminal",
		});
	});

	it("reads a delegated child's events when the child run id is passed as runId", async () => {
		const db = createKernelRuntimeDb();
		const childRunId = "tedi-cto:mcp:home-child-alias-1_approved_tedi-cto";
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-child-alias-1",
				organizationId: ORG_ID,
				conversationId: "home:child-alias",
				status: "running",
				delegatedTediId: "tedi-cto",
				childRunId,
			}),
		);
		db.runtimeEvents.push(
			childRuntimeEvent({
				createdAt: "2026-10-23T14:51:02.000Z",
				id: "child-alias-context",
				kind: "context.injected",
				runId: childRunId,
				tediId: "tedi-cto",
			}),
		);

		const client = createKernelRuntimeClient(createContext(db));
		const result = await client.readRunEvents({ runId: childRunId });

		expect(result.events.map((event) => event.id)).toEqual([
			"child-alias-context",
		]);
		expect(result.stream.streamId).toBe(
			`home:home-child-alias-1:child:${childRunId}`,
		);
	});

	it("fails a Home run whose delegated child went silent past its deadline", async () => {
		const db = createKernelRuntimeDb();
		const childRunId = "tedi-cfo:mcp:home-child-stall-1_approved_tedi-cfo";
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-child-stall-1",
				organizationId: ORG_ID,
				conversationId: "home:child-stall",
				status: "running",
				delegatedTediId: "tedi-cfo",
				childRunId,
				startedAt: "2026-01-05T14:50:52.000Z",
				createdAt: "2026-01-05T14:50:47.000Z",
				updatedAt: "2026-01-05T14:57:09.000Z",
				metadata: {
					delegationWorkOrder: {
						budget: { maxToolCalls: 12, deadlineMs: 600_000 },
					},
				},
			}),
		);
		db.runtimeEvents.push(
			childRuntimeEvent({
				createdAt: "2026-01-05T14:50:52.000Z",
				id: "child-stall-started",
				kind: "run.started",
				runId: childRunId,
				tediId: "tedi-cfo",
			}),
			childRuntimeEvent({
				createdAt: "2026-01-05T14:57:09.000Z",
				id: "child-stall-context",
				kind: "context.injected",
				runId: childRunId,
				tediId: "tedi-cfo",
			}),
		);

		const client = createKernelRuntimeClient(createContext(db));
		const { run } = await client.readRun({ runId: "home-child-stall-1" });

		expect(run.status).toBe("failed");
		expect(run.metadata?.childRunPreview).toContain(
			"The tedi stopped responding and did not finish within its 10-minute limit.",
		);
	});

	it("attempts settlement repair for an admitted terminal parent with no receipt", async () => {
		const db = createKernelRuntimeDb();
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-missed-settlement",
				organizationId: ORG_ID,
				conversationId: "home:missed-settlement",
				status: "completed",
				completedAt: "2026-07-19T20:41:24.082Z",
			}),
		);
		db.events.push(
			normalizeKernelRuntimeEventInsert({
				id: "home-admitted",
				organizationId: ORG_ID,
				kind: "submission.admitted",
				conversationId: "home:missed-settlement",
				runId: "home-missed-settlement",
				payload: { submissionId: "sub:home-missed-settlement" },
				createdAt: "2026-07-19T20:40:00.000Z",
			}),
			normalizeKernelRuntimeEventInsert({
				id: "home-completed",
				organizationId: ORG_ID,
				kind: "run.completed",
				conversationId: "home:missed-settlement",
				runId: "home-missed-settlement",
				createdAt: "2026-07-19T20:41:24.082Z",
			}),
		);
		const client = createKernelRuntimeClient(createContext(db));

		await client.readRunEvents({
			runId: "home-missed-settlement",
			offset: 0,
		});

		expect(db.submissionSettleCalls).toContainEqual({
			submissionId: "sub:home-missed-settlement",
			outcome: "settled",
		});
	});

	it("rejects child selectors that are not referenced by the authorized parent", async () => {
		const db = createKernelRuntimeDb();
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-child-stream-auth",
				organizationId: ORG_ID,
				conversationId: "home:child-stream-auth",
				status: "running",
				delegatedTediId: "tedi-cto",
				childRunId: "allowed-child",
			}),
		);
		const client = createKernelRuntimeClient(createContext(db));

		await expect(
			client.readRunEvents({
				runId: "home-child-stream-auth",
				childRunId: "other-child",
				delegatedTediId: "tedi-cto",
			}),
		).rejects.toThrow(/Delegated child run not found/);
		await expect(
			client.readRunEvents({
				runId: "home-child-stream-auth",
				childRunId: "allowed-child",
				delegatedTediId: "tedi-cpo",
			}),
		).rejects.toThrow(/Delegated child run not found/);
	});

	it("requires edit grants for Home turn posting after a conversation opts in", async () => {
		const db = createKernelRuntimeDb({
			grantRows: [
				grantRow({
					access: "read",
					conversationId: "home:locked",
					userId: "operator-1",
				}),
			],
		});
		const reader = createKernelRuntimeClient(
			createContext(db, { userSub: "operator-1" }),
		);
		await expect(
			reader.enqueueMessage({
				conversationId: "home:locked",
				content: "should not post",
				idempotencyKey: "grant-denied-1",
			}),
		).rejects.toThrow(/Access denied/);

		db.grantRows[0].access = "edit";
		await expect(
			reader.enqueueMessage({
				conversationId: "home:locked",
				content: "can post now",
				idempotencyKey: "grant-allowed-1",
			}),
		).resolves.toMatchObject({
			conversationId: "home:locked",
		});
	});

	it("requires conversation write access for steering inspection and withdrawal", async () => {
		const db = createKernelRuntimeDb({
			grantRows: [
				grantRow({
					access: "read",
					conversationId: "home:steering-access",
					userId: "operator-1",
				}),
			],
		});
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "steering-access",
				organizationId: ORG_ID,
				conversationId: "home:steering-access",
				status: "running",
			}),
		);
		const values = new Map<string, unknown>();
		const inbox = new HomeRunSteering({
			get: <T>(key: string) => values.get(key) as T | undefined,
			put: <T>(key: string, value: T) => {
				values.set(key, value);
			},
		});
		const control = vi.fn(
			async (input: Parameters<HomeRunSteering["control"]>[0]) =>
				inbox.control(input),
		);
		const context = createContext(db, {
			userSub: "operator-1",
			env: {
				KERNEL: {
					idFromName: (name: string) => name,
					get: () => ({ controlRunSteering: control }),
				},
			},
		});
		const client = createKernelRuntimeClient(context);
		await expect(
			client.steerRun({
				runId: "steering-access",
				instruction: "Change direction",
			}),
		).rejects.toThrow(/Access denied/);
		for (const action of ["inspect", "withdraw"] as const)
			await expect(
				client.controlRunSteering({ runId: "steering-access", action }),
			).rejects.toThrow(/Access denied/);
		expect(control).not.toHaveBeenCalled();
		db.grantRows[0].access = "edit";
		await client.steerRun({
			runId: "steering-access",
			instruction: "Change direction",
			idempotencyKey: "steer-access",
		});
		expect(
			(
				await client.controlRunSteering({
					runId: "steering-access",
					action: "inspect",
				})
			).messages,
		).toEqual([
			{
				id: "steering-access:steer:steer-access",
				content: "Change direction",
				status: "queued",
			},
		]);
		db.runs[0].status = "completed";
		await client.steerRun({
			runId: "steering-access",
			instruction: "Change direction",
			idempotencyKey: "steer-access",
		});
		await expect(
			client.steerRun({
				runId: "steering-access",
				instruction: "Different content",
				idempotencyKey: "steer-access",
			}),
		).rejects.toThrow(/different content/);
		await expect(
			client.steerRun({
				runId: "steering-access",
				instruction: "New turn",
				idempotencyKey: "new-key",
			}),
		).rejects.toThrow(/already ended/);
		expect(
			(
				await client.controlRunSteering({
					runId: "steering-access",
					action: "withdraw",
				})
			).messages,
		).toEqual([
			{
				id: "steering-access:steer:steer-access",
				content: "Change direction",
				status: "withdrawn",
			},
		]);
		expect(db.runs).toHaveLength(1);
	});

	it("returns a read-only child-run tree for delegated Home runs", async () => {
		const db = createKernelRuntimeDb();
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-run-1",
				organizationId: ORG_ID,
				conversationId: "home:tree",
				status: "running",
				delegatedTediId: "tedi-cto",
				childRunId: "child-run-1",
				metadata: { delegatedTediSlug: "cto", childRunStatus: "running" },
				createdAt: "2026-06-06T08:00:00.000Z",
				updatedAt: "2026-06-06T08:01:00.000Z",
			}),
		);
		const client = createKernelRuntimeClient(createContext(db));

		const result = await client.readChildRunTree({
			conversationId: "home:tree",
		});

		expect(result.tree).toMatchObject({
			conversationId: "home:tree",
			activeNodeId: "child:tedi-cto:child-run-1",
			nodes: [
				{
					id: "child:tedi-cto:child-run-1",
					homeRunId: "home-run-1",
					delegatedTediId: "tedi-cto",
					childRunId: "child-run-1",
					label: "cto",
					status: "running",
					active: true,
					children: [],
				},
			],
		});
	});

	it("routes a plain Home turn through the Kernel when it returns a decision", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		const kernel = vi.fn(async () => ({
			assistantContent: "ROUTED:gmail",
			route: {
				routeKind: "delegate_tedi" as const,
				rationale: "Operator wants Gmail read by its accountable tedi.",
				risk: "low" as const,
				confidence: 0.78,
				toolIntent: {
					appSlug: "gmail",
					capability: "gmail.read",
					connectionStatus: "connected" as const,
				},
			},
		}));
		kernelRuntimeTestHooks.setKernelForTest(kernel);

		const result = await client.enqueueMessage({
			conversationId: "home:test",
			content: "check my gmail messages",
			idempotencyKey: "kernel-route-1",
		});
		const causalEvents = (await db.select().from(kernelRuntimeEvents)).filter(
			(event) => event.runId === result.run.id,
		);
		const inputEvent = causalEvents.find(
			(event) => event.kind === "message.received",
		);
		const startEvent = causalEvents.find(
			(event) => event.kind === "run.started",
		);
		expect(startEvent?.causeEventId).toBe(inputEvent?.id);
		expect(inputEvent?.id).toBe(
			homeRuntimeEventId({
				organizationId: ORG_ID,
				kind: "message.received",
				conversationId: "home:test",
				runId: result.run.id,
				messageId: `${result.run.id}:input`,
			}),
		);
		const messages = await client.readMessages({
			conversationId: "home:test",
			limit: 10,
		});

		expect(kernel).toHaveBeenCalledTimes(1);
		expect(kernel.mock.calls[0]?.[0]).toMatchObject({
			organizationId: ORG_ID,
			content: "check my gmail messages",
			// Kernel conversational memory seam: the turn body threads the
			// conversation id (bounded history scope) and the current turn's
			// already-persisted user message id (excluded from history).
			conversationId: "home:test",
			currentUserMessageId: "kernel-route-1:input",
		});
		// The kernel's assistantContent replaces the generic heuristic text.
		expect(result.assistantMessage?.content).toBe("ROUTED:gmail");
		const persistedAssistant = messages.messages.find(
			(message) => message.role === "assistant",
		);
		expect(persistedAssistant?.content).toBe("ROUTED:gmail");
		// The typed route decision is carried on the run metadata.
		expect(result.run.metadata).toMatchObject({
			kernelRoute: { routeKind: "delegate_tedi" },
		});
	});

	it("preserves a legacy null Home run-start cause on HTTP replay", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		kernelRuntimeTestHooks.setKernelForTest(
			vi.fn(async () => ({
				assistantContent: "ok",
				route: {
					routeKind: "answer" as const,
					rationale: "answer",
					risk: "low" as const,
					confidence: 1,
				},
			})),
		);
		const runId = "legacy-causal-run";
		const messageId = `${runId}:input`;
		await db.insert(kernelRuntimeEvents).values({
			id: homeRuntimeEventId({
				organizationId: ORG_ID,
				kind: "run.started",
				conversationId: "home:legacy-cause",
				runId,
				messageId,
			}),
			organizationId: ORG_ID,
			kind: "run.started",
			conversationId: "home:legacy-cause",
			runId,
			messageId,
			causeEventId: null,
		});
		await client.enqueueMessage({
			conversationId: "home:legacy-cause",
			content: "retry",
			idempotencyKey: runId,
		});
		const start = (await db.select().from(kernelRuntimeEvents)).find(
			(event) =>
				event.id.includes("event:run.started") && event.runId === runId,
		);
		expect(start?.causeEventId).toBeNull();
	});

	it("auto-dispatches an authorized Kernel delegate_tedi route and links the child run", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db, {
			userSub: "operator-1",
		});
		const client = createKernelRuntimeClient(context);
		const delegateRunner = vi.fn(
			async (input: {
				childRunId: string;
				metadata: Record<string, unknown>;
			}) => ({
				childConversationId: "agent:main:main",
				childRunId: input.childRunId,
				status: "queued" as const,
			}),
		);
		kernelRuntimeTestHooks.setDelegateRunnerForTest(delegateRunner);
		kernelRuntimeTestHooks.setKernelForTest(
			vi.fn(async () => ({
				assistantContent: "CPO owns this. Dispatching the work order.",
				route: {
					routeKind: "delegate_tedi" as const,
					rationale: "CPO owns product coding tasks.",
					risk: "medium" as const,
					confidence: 0.98,
					effortClass: "embodied" as const,
					answer: "Delegating to CPO.",
					targetTediId: "tedi-cpo",
					targetTediLabel: "CPO",
					toolIntent: null,
					workflowHint: null,
					clarifyingQuestion: null,
					evidenceExpectation: "Return the workstation proof.",
				},
				delegation: {
					workOrder: {
						objective: "Run a bounded CPO workstation proof.",
						executionRequirement: WORKSTATION_EXECUTION_REQUIREMENT,
						outputContract:
							"Return the marker, pwd, git status, and gh version.",
						toolGuidance: ["Use the workstation tools."],
						boundaries: ["Do not write files or push."],
						sourceContent: "Ask CPO to run the workstation proof.",
						targetTediId: "tedi-cpo",
						targetTediLabel: "CPO",
					},
					decision: {
						canAutoDispatch: true,
						mode: "auto",
						reason:
							"authorized operator delegating to an active in-scope target with no high-risk signal",
					},
				},
			})) as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelForTest
			>[0],
		);

		const result = await client.enqueueMessage({
			conversationId: "home:test",
			content: "Ask CPO to run the workstation proof.",
			idempotencyKey: "home-auto-deleg-1",
		});

		expect(delegateRunner).toHaveBeenCalledTimes(1);
		expect(delegateRunner.mock.calls[0]?.[0]).toMatchObject({
			childRunId: "home-auto-deleg-1:auto:tedi-cpo",
			delegateToTediId: "tedi-cpo",
			metadata: {
				source: "kernelRuntime.autoDispatch",
				homeRunId: "home-auto-deleg-1",
				homeConversationId: "home:test",
				homeMessageId: "home-auto-deleg-1:input",
				delegationWorkOrder: {
					objective: "Run a bounded CPO workstation proof.",
				},
			},
		});
		expect(result).toMatchObject({
			status: "queued",
			run: {
				id: "home-auto-deleg-1",
				status: "queued",
				delegatedTediId: "tedi-cpo",
				childRunId: "home-auto-deleg-1:auto:tedi-cpo",
				completedAt: null,
				metadata: {
					childRunId: "home-auto-deleg-1:auto:tedi-cpo",
					delegatedTediId: "tedi-cpo",
					homeAutoDispatch: {
						childRunId: "home-auto-deleg-1:auto:tedi-cpo",
						delegatedTediId: "tedi-cpo",
						status: "queued",
					},
					homeDelegation: {
						decision: { mode: "auto", canAutoDispatch: true },
					},
				},
			},
		});
		expect(db.runs[0]).toMatchObject({
			id: "home-auto-deleg-1",
			status: "queued",
			delegatedTediId: "tedi-cpo",
			childRunId: "home-auto-deleg-1:auto:tedi-cpo",
			completedAt: null,
		});
		expect(db.events.at(-1)).toMatchObject({
			kind: "run.completed",
			delegatedTediId: "tedi-cpo",
			childRunId: "home-auto-deleg-1:auto:tedi-cpo",
			payload: {
				status: "queued",
				childRunId: "home-auto-deleg-1:auto:tedi-cpo",
				delegationWorkOrder: {
					objective: "Run a bounded CPO workstation proof.",
				},
			},
			runtimeMetadata: {
				delegationStatus: "queued",
				delegationWorkOrder: {
					objective: "Run a bounded CPO workstation proof.",
				},
			},
		});
	});

	it("observe-only preserves a delegate route while suppressing its dispatch", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(
			createContext(db, { userSub: "operator-1" }),
		);
		const delegateRunner = vi.fn();
		kernelRuntimeTestHooks.setDelegateRunnerForTest(delegateRunner);
		kernelRuntimeTestHooks.setKernelForTest(
			vi.fn(async () => ({
				assistantContent: "CPO would own this task.",
				route: {
					routeKind: "delegate_tedi" as const,
					rationale: "CPO owns product work.",
					risk: "medium" as const,
					confidence: 0.98,
					targetTediId: "tedi-cpo",
				},
				delegation: {
					workOrder: {
						objective: "Run the task.",
						executionRequirement: WORKSTATION_EXECUTION_REQUIREMENT,
						outputContract: "Return proof.",
						toolGuidance: [],
						boundaries: [],
						sourceContent: "Run it.",
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
			conversationId: "home:observe",
			content: "Who should run this?",
			idempotencyKey: "observe-delegate-1",
			executionPolicy: "observe_only",
		});

		expect(delegateRunner).not.toHaveBeenCalled();
		expect(result.run.metadata).toMatchObject({
			executionPolicy: "observe_only",
			effectsSuppressed: true,
			kernelRoute: null,
			kernelObservation: {
				selectedRoute: { routeKind: "delegate_tedi" },
				outcome: "effects_suppressed",
			},
			homeDelegation: null,
		});
		expect(result.assistantMessage?.content).toBe(
			"Observation only: Kernel selected delegate_tedi. No tools, workflows, approvals, writes, Work Items, or delegations were executed.",
		);
		expect(result.run.childRunId).toBeNull();
		expect(
			db.events.find((event) => event.kind === "run.completed")?.payload,
		).toMatchObject({ status: "completed" });
	});

	it("observe-only rejects explicit delegation before target or Work effects", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(
			createContext(db, { userSub: "operator-1" }),
		);
		await expect(
			client.enqueueMessage({
				conversationId: "home:observe-explicit",
				content: "Delegate this",
				idempotencyKey: "observe-explicit-1",
				delegateToTediId: "tedi-cpo",
				executionPolicy: "observe_only",
			}),
		).rejects.toThrow(/cannot explicitly delegate/);
		expect(db.workItemRows).toHaveLength(0);
		expect(db.approvals).toHaveLength(0);
		await expect(
			client.enqueueMessage({
				conversationId: "home:observe-attachment",
				content: "Inspect this",
				idempotencyKey: "observe-attachment-1",
				executionPolicy: "observe_only",
				attachments: [
					{
						content: "SGVsbG8=",
						fileName: "evidence.txt",
						mimeType: "text/plain",
						type: "file",
					},
				],
			}),
		).rejects.toThrow(/cannot include attachments/);
	});

	it("threads conversation history across kernel turns and isolates conversations", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		// The stub runs the real context assembly against the fake D1 ledger
		// with exactly the args the turn body threads through — pinning the
		// persist-first transcript → history seam end to end.
		const histories: Array<Array<{ role: string; content: string }>> = [];
		kernelRuntimeTestHooks.setKernelForTest(async (args) => {
			const ctx = await assembleHomeContext(args.db, args.organizationId, {
				conversationId: args.conversationId,
				excludeMessageId: args.currentUserMessageId,
			});
			histories.push(ctx.history);
			return {
				assistantContent: "Noted.",
				route: {
					routeKind: "answer_in_home" as const,
					rationale: "memory turn",
					risk: "low" as const,
					confidence: 0.9,
					effortClass: "single_read" as const,
					answer: "Noted.",
					targetTediId: null,
					targetTediLabel: null,
					toolIntent: null,
					workflowHint: null,
					clarifyingQuestion: null,
					evidenceExpectation: null,
				},
			};
		});

		await client.enqueueMessage({
			conversationId: "home:memory-a",
			content: "remember my codename is BLUEFALCON-7919",
			idempotencyKey: "memory-a-1",
		});
		await client.enqueueMessage({
			conversationId: "home:memory-a",
			content: "what's my codename?",
			idempotencyKey: "memory-a-2",
		});
		await client.enqueueMessage({
			conversationId: "home:memory-b",
			content: "unrelated turn in another conversation",
			idempotencyKey: "memory-b-1",
		});

		expect(histories).toHaveLength(3);
		// Turn 1: brand-new conversation — its own in-flight user message is
		// already persisted (persist-first) but excluded, so history is empty.
		expect(histories[0]).toEqual([]);
		// Turn 2 (same conversation): sees turn 1's user message and the
		// kernel's answer, oldest → newest — and not its own in-flight message.
		expect(histories[1]?.map((message) => message.content)).toEqual([
			"remember my codename is BLUEFALCON-7919",
			"Noted.",
		]);
		// Cross-conversation isolation: a turn in conversation B sees none of A.
		expect(histories[2]).toEqual([]);
	});

	it("generates a runId when idempotencyKey is omitted (ask ergonomics)", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		const kernel = vi.fn(async () => ({
			assistantContent: "ROUTED:no-key",
			route: {
				routeKind: "answer_in_home" as const,
				rationale: "Simple question answered in Home.",
				risk: "low" as const,
				confidence: 0.9,
				answer: "ROUTED:no-key",
			},
		}));
		kernelRuntimeTestHooks.setKernelForTest(kernel);

		// No idempotencyKey supplied — the MCP ask path relies on this.
		const result = await client.enqueueMessage({
			conversationId: "home:nokey",
			content: "what's our status?",
		});

		expect(result.idempotencyKey).toBeTruthy();
		expect(result.run.id).toBe(result.idempotencyKey);
		expect(kernel).toHaveBeenCalledTimes(1);
		expect(result.assistantMessage?.content).toBe("ROUTED:no-key");
	});

	it("reads one Home run by id via readRun", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		kernelRuntimeTestHooks.setKernelForTest(vi.fn(async () => null));

		const created = await client.enqueueMessage({
			conversationId: "home:readrun",
			content: "hello",
			idempotencyKey: "home-readrun-1",
		});
		const read = await client.readRun({ runId: created.run.id });

		expect(read.run.id).toBe("home-readrun-1");
		expect(read.run.conversationId).toBe("home:readrun");
	});

	it("persists the turn BEFORE the kernel resolves and patches the route after (caller-disconnect protection)", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db) as BaseContext & {
			waitUntilPromises: Promise<unknown>[];
		};
		const client = createKernelRuntimeClient(context);
		let resolveKernel!: (value: {
			assistantContent: string;
			route: Record<string, unknown>;
		}) => void;
		const gate = new Promise<{
			assistantContent: string;
			route: Record<string, unknown>;
		}>((resolve) => {
			resolveKernel = resolve;
		});
		kernelRuntimeTestHooks.setKernelForTest(
			vi.fn(() => gate) as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelForTest
			>[0],
		);

		const pending = client.enqueueMessage({
			conversationId: "home:durable",
			content: "check my gmail inbox",
			idempotencyKey: "home-durable-1",
		});
		// Flush the pre-kernel persistence (events + run row) while the kernel
		// is still in flight.
		await new Promise((resolve) => setTimeout(resolve, 0));

		const mid = await client.readRun({ runId: "home-durable-1" });
		expect(mid.run.status).toBe("running");
		expect(mid.run.metadata).toMatchObject({ kernelRoute: null });
		// The kernel work is registered with waitUntil: a disconnected caller
		// no longer cancels the route decision or loses the turn.
		expect(context.waitUntilPromises.length).toBeGreaterThan(0);

		resolveKernel({
			assistantContent: "ROUTED:durable",
			route: {
				routeKind: "answer_in_home",
				rationale: "Answer the operator.",
				risk: "low",
				confidence: 0.8,
				toolIntent: {
					appSlug: "gmail",
					capability: "gmail.read",
					connectionStatus: "connected",
				},
			},
		});
		const result = await pending;
		expect(result.assistantMessage?.content).toBe("ROUTED:durable");
		expect(result.run.status).toBe("completed");

		const read = await client.readRun({ runId: "home-durable-1" });
		expect(read.run.status).toBe("completed");
		expect(read.run.metadata).toMatchObject({
			kernelRoute: { routeKind: "answer_in_home" },
			kernelEvidence: null,
		});
	});

	it("a cancel that lands mid-kernel wins over the completion patch (running → completed guard)", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const client = createKernelRuntimeClient(context);
		let resolveKernel!: (value: {
			assistantContent: string;
			route: Record<string, unknown>;
		}) => void;
		const gate = new Promise<{
			assistantContent: string;
			route: Record<string, unknown>;
		}>((resolve) => {
			resolveKernel = resolve;
		});
		kernelRuntimeTestHooks.setKernelForTest(
			vi.fn(() => gate) as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelForTest
			>[0],
		);

		const pending = client.enqueueMessage({
			conversationId: "home:cancel-race",
			content: "slow kernel turn",
			idempotencyKey: "home-cancel-race-1",
		});
		await new Promise((resolve) => setTimeout(resolve, 0));

		// Operator cancels while the kernel is still planning. The run is
		// non-terminal ("running"), so cancelRun accepts it.
		const canceled = await client.cancelRun({
			runId: "home-cancel-race-1",
			reason: "operator changed their mind",
		});
		expect(canceled.run.status).toBe("canceled");

		resolveKernel({
			assistantContent: "ROUTED:too-late",
			route: {
				routeKind: "answer_in_home",
				rationale: "Late kernel result.",
				risk: "low",
				confidence: 0.9,
				answer: "ROUTED:too-late",
			},
		});
		await pending;

		const read = await client.readRun({ runId: "home-cancel-race-1" });
		expect(read.run.status).toBe("canceled");
		expect(read.run.metadata).toMatchObject({ kernelRoute: null });
		expect(db.auditRows).toContainEqual(
			expect.objectContaining({
				actorId: "api-key-1",
				actorType: "api_key",
				action: "kernel.run.canceled",
				resourceType: "kernel_run",
				resourceId: "home-cancel-race-1",
				metadata: expect.objectContaining({
					source: "kernelRuntime.cancelRun",
					conversationId: "home:cancel-race",
					reason: "operator changed their mind",
				}),
			}),
		);
	});

	it("steers an active Home run and preserves the steering through kernel completion", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const client = createKernelRuntimeClient(context);
		let resolveKernel!: (value: {
			assistantContent: string;
			route: Record<string, unknown>;
		}) => void;
		const gate = new Promise<{
			assistantContent: string;
			route: Record<string, unknown>;
		}>((resolve) => {
			resolveKernel = resolve;
		});
		kernelRuntimeTestHooks.setKernelForTest(
			vi.fn(() => gate) as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelForTest
			>[0],
		);

		const pending = client.enqueueMessage({
			conversationId: "home:steer-race",
			content: "slow kernel turn",
			idempotencyKey: "home-steer-race-1",
		});
		await new Promise((resolve) => setTimeout(resolve, 0));

		const values = new Map<string, unknown>();
		const inbox = new HomeRunSteering({
			get: <T>(key: string) => values.get(key) as T | undefined,
			put: <T>(key: string, value: T) => {
				values.set(key, value);
			},
		});
		Object.assign(context.env, {
			KERNEL: {
				idFromName: (name: string) => name,
				get: () => ({
					controlRunSteering: async (
						input: Parameters<HomeRunSteering["control"]>[0],
					) => inbox.control(input),
				}),
			},
		});
		const steered = await client.steerRun({
			runId: "home-steer-race-1",
			instruction: "Focus on Acme evidence first.",
		});
		expect(steered.run.status).toBe("running");
		expect(steered.run.metadata).toMatchObject({
			latestSteeringInstruction: "Focus on Acme evidence first.",
		});
		expect(
			db.events.some(
				(event) =>
					event.kind === "message.received" &&
					event.messageId?.startsWith("home-steer-race-1:steer:") &&
					(event.payload as { content?: string } | null)?.content ===
						"Focus on Acme evidence first.",
			),
		).toBe(true);

		resolveKernel({
			assistantContent: "ROUTED:after-steer",
			route: {
				routeKind: "answer_in_home",
				rationale: "Late kernel result.",
				risk: "low",
				confidence: 0.9,
				answer: "ROUTED:after-steer",
			},
		});
		await pending;

		const read = await client.readRun({ runId: "home-steer-race-1" });
		expect(read.run.status).toBe("completed");
		expect(read.run.metadata).toMatchObject({
			latestSteeringInstruction: "Focus on Acme evidence first.",
			kernelRoute: { routeKind: "answer_in_home" },
		});
		const instructions = (read.run.metadata as Record<string, unknown>)
			.steeringInstructions as Array<Record<string, unknown>>;
		expect(instructions.at(-1)).toMatchObject({
			instruction: "Focus on Acme evidence first.",
			source: "kernelRuntime.steerRun",
		});
		expect(db.auditRows).toContainEqual(
			expect.objectContaining({
				actorId: "api-key-1",
				actorType: "api_key",
				action: "kernel.run.steered",
				resourceType: "kernel_run",
				resourceId: "home-steer-race-1",
				metadata: expect.objectContaining({
					source: "kernelRuntime.steerRun",
					conversationId: "home:steer-race",
					instructionLength: "Focus on Acme evidence first.".length,
					instructionPreview: "Focus on Acme evidence first.",
				}),
			}),
		);
	});

	it("queues a route failure for automatic redrive, and preserves manual retry access checks after exhaustion", async () => {
		const db = createKernelRuntimeDb();
		const context = {
			...createContext(db, { userSub: "member-1" }),
			authType: "user" as const,
			apiKey: undefined,
			userRole: "member" as const,
		};
		const scheduled: unknown[] = [];
		context.env.KERNEL = {
			idFromName: (id: string) => id,
			get: () => ({
				scheduleRouteRedrive: async (input: unknown) => {
					scheduled.push(input);
				},
			}),
		} as unknown as CloudflareEnv["KERNEL"];
		const client = createKernelRuntimeClient(context);
		const kernel = vi.fn(async (_input: unknown) => null);
		kernelRuntimeTestHooks.setKernelForTest(kernel);

		const result = await client.enqueueMessage({
			conversationId: "home:test",
			content: "Capture this idea for the quarterly planning review",
			idempotencyKey: "kernel-null-1",
			metadata: {
				allowWorkflowConfirmation: true,
				chatApprovalReply: {
					runId: "forged",
					decision: "approve",
					tool: "forged",
					runStatus: "completed",
				},
			},
		});
		const messages = await client.readMessages({
			conversationId: "home:test",
			limit: 10,
		});

		expect(kernel).toHaveBeenCalledTimes(1);
		// The durable retry is queued before reporting it to the caller.
		expect(result.status).toBe("queued");
		expect(result.run.status).toBe("queued");
		expect(scheduled).toHaveLength(1);
		expect(result.run.metadata).toMatchObject({
			redriveInput: { allowWorkflowConfirmation: false },
		});
		expect(result.assistantMessage?.content).toContain(
			"configured model did not produce a valid route decision",
		);
		const persistedAssistant = messages.messages.find(
			(message) => message.role === "assistant",
		);
		expect(persistedAssistant?.content).toContain(
			"configured model did not produce a valid route decision",
		);
		expect(result.run.metadata).toMatchObject({
			kernelRoute: null,
			routeFailure: {
				code: "HOME_ROUTE_UNAVAILABLE",
				retryable: true,
				retryRunId: result.run.id,
			},
		});
		const { transitionKernelRuntimeRunStatus } =
			await import("@tedix/db/queries/kernel-runtime-runs");
		await transitionKernelRuntimeRunStatus(context.db, {
			id: result.run.id,
			organizationId: result.run.organizationId,
			fromStatus: "queued",
			patch: { status: "running" },
		});
		const { runKernelTurnWork } = await import("./kernel/turn-work");
		const { buildKernelTurnWorkDeps } =
			await import("./kernel-runtime/turn-delegation");
		const saved =
			scheduled[0] as import("./kernel/turn-work-context").KernelTurnWorkInput;
		const exhausted = await runKernelTurnWork(
			buildKernelTurnWorkDeps(context),
			{
				...saved,
				assistantMessageId: `${saved.assistantMessageId}:route-redrive`,
				runRowMetadata: { ...saved.runRowMetadata, routeRetryCount: 1 },
			},
		);
		expect(exhausted.run.status).toBe("failed");
		expect(
			(await client.readRun({ runId: result.run.id })).run.outputMessageId,
		).toBe(exhausted.assistantMessage.id);
		expect(scheduled).toHaveLength(1);
		expect(exhausted.assistantMessage.content).toContain(
			"retried it automatically once",
		);
		const otherMember = createKernelRuntimeClient({
			...context,
			user: { sub: "member-2" } as BaseContext["user"],
		});
		await expect(
			otherMember.retryRun({ runId: result.run.id }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		db.grantRows.push(
			grantRow({
				conversationId: "home:test",
				userId: "member-1",
				access: "read",
			}),
		);
		await expect(
			client.retryRun({ runId: result.run.id }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		db.grantRows[0]!.access = "edit";
		const [retried, duplicate] = await Promise.all([
			client.retryRun({ runId: result.run.id }),
			client.retryRun({ runId: result.run.id }),
		]);
		const repeated = await client.retryRun({ runId: result.run.id });
		expect(repeated.newRunId).toBe(retried.newRunId);
		expect(retried.newRunId).not.toBe(result.run.id);
		expect(duplicate.newRunId).toBe(retried.newRunId);
		expect(kernel).toHaveBeenCalledTimes(3);
		expect(kernel.mock.calls[1]?.[0]).toMatchObject({
			content: "Capture this idea for the quarterly planning review",
			conversationId: "home:test",
		});
	});

	it("records Home turns against the organization subject instead of a hidden tedi", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		// LLM-only kernel: provide a real answer_in_home route so the turn settles
		// normally (the org-subject assertions below are the point of this test).
		kernelRuntimeTestHooks.setKernelForTest(async () => ({
			assistantContent: "Captured against the org subject.",
			route: {
				routeKind: "answer_in_home" as const,
				rationale: "home subject smoke",
				risk: "low" as const,
				confidence: 0.9,
				effortClass: "single_read" as const,
				answer: "Captured against the org subject.",
				targetTediId: null,
				targetTediLabel: null,
				toolIntent: null,
				workflowHint: null,
				clarifyingQuestion: null,
				evidenceExpectation: null,
			},
			evidence: null,
		}));

		const result = await client.enqueueMessage({
			conversationId: "home:test",
			content: "Validate the Home subject",
			idempotencyKey: "home-smoke-1",
		});
		const messages = await client.readMessages({
			conversationId: "home:test",
			limit: 10,
		});

		expect(result).toMatchObject({
			conversationId: "home:test",
			status: "completed",
			run: {
				delegatedTediId: null,
				runtime: {
					backend: "custom",
				},
			},
		});
		expect(result.assistantMessage?.content).toContain(
			"Captured against the org subject.",
		);
		expect(messages.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
		]);
		expect(db.events.every((event) => event.organizationId === ORG_ID)).toBe(
			true,
		);
		expect(db.events.every((event) => event.delegatedTediId === null)).toBe(
			true,
		);
	});

	it("drafts a multi-assignment Home plan for CPO and Echo before dispatch", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		const delegateRunner = vi.fn(async (input) => ({
			childRunId: input.childRunId,
			status: "queued" as const,
		}));
		kernelRuntimeTestHooks.setDelegateRunnerForTest(delegateRunner);

		const result = await client.enqueueMessage({
			conversationId: "home:test",
			content:
				"Plan this across CPO and Echo: CPO owns the product checklist while Echo validates evidence and gaps.",
			idempotencyKey: "home-plan-1",
		});

		expect(delegateRunner).not.toHaveBeenCalled();
		expect(result.status).toBe("needs_delegation");
		expect(result.run.delegatedTediId).toBeNull();
		expect(result.homePlan).toMatchObject({
			id: "home-plan-1:plan",
			status: "proposed",
			assignments: [
				{
					ownerTediId: "tedi-cpo",
					ownerLabel: "CPO",
					routeKind: "agent",
					status: "proposed",
				},
				{
					ownerTediId: "tedi-echo",
					ownerLabel: "Echo (Isolate)",
					routeKind: "agent",
					status: "proposed",
				},
			],
		});
		expect(result.assistantMessage?.content).toContain("I drafted a Home plan");
		expect(result.assistantMessage?.metadata).toMatchObject({
			metadata: {
				homePlan: {
					id: "home-plan-1:plan",
					assignments: [
						{ ownerTediId: "tedi-cpo" },
						{ ownerTediId: "tedi-echo" },
					],
				},
			},
		});
		expect(db.runs[0]?.metadata).toMatchObject({
			homePlan: {
				id: "home-plan-1:plan",
				assignments: [
					{ ownerTediId: "tedi-cpo" },
					{ ownerTediId: "tedi-echo" },
				],
			},
		});
		expect(
			db.events.some(
				(event) =>
					event.kind === "decision.recorded" &&
					event.runId === "home-plan-1" &&
					(event.payload as { homePlan?: { id?: string } } | null)?.homePlan
						?.id === "home-plan-1:plan",
			),
		).toBe(true);
		expect(db.events.every((event) => event.delegatedTediId === null)).toBe(
			true,
		);
	});

	it("plan-producing turn settles its kernel submission in-band", async () => {
		// Regression test for the plan-path in-band settle gap: a turn that parks a
		// homePlan (multi-tedi request) completes immediately with status="completed"
		// but its kernel submission was admitted by insertKernelRuntimeRun and then
		// never settled in turn-work (plan turns bypass kernelEligible). The fix adds
		// settleKernelSubmission on the plan-park path; this test asserts the call is
		// made in-band with outcome "settled" before returning.
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const client = createKernelRuntimeClient(context);
		kernelRuntimeTestHooks.setDelegateRunnerForTest(async (input) => ({
			childRunId: input.childRunId,
			status: "queued" as const,
		}));

		await client.enqueueMessage({
			conversationId: "home:test",
			content:
				"Plan this across CPO and Echo: CPO takes the roadmap while Echo audits evidence.",
			idempotencyKey: "home-plan-settle-1",
		});
		await Promise.all(context.waitUntilPromises);

		// The submission id is deterministic: kernelSubmissionId("home-plan-settle-1") = "sub:home-plan-settle-1"
		const settleCall = db.submissionSettleCalls.find(
			(call) => call.submissionId === "sub:home-plan-settle-1",
		);
		expect(settleCall).toBeDefined();
		expect(settleCall?.outcome).toBe("settled");
	});

	it("approves a Home plan into Work Items and dispatches isolate assignments", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const client = createKernelRuntimeClient(context);
		const delegateRunner = vi.fn(async (input) => ({
			childConversationId: "agent:main:main",
			childRunId: `${input.delegateToTediId}:mcp:${input.childRunId.replaceAll(":", "_")}`,
			status: "queued" as const,
		}));
		kernelRuntimeTestHooks.setDelegateRunnerForTest(delegateRunner);

		const originalRequest = `Plan this across CPO and Echo: CPO owns the launch plan while Echo validates the data.\n${"Supporting detail. ".repeat(900)}\nMiddle acceptance: the independent oracle must remain unchanged.\n${"Further context. ".repeat(1000)}\nFinal acceptance: preserve both merge parents.`;
		const proposed = await client.enqueueMessage({
			conversationId: "home:test",
			content: originalRequest,
			idempotencyKey: "home-plan-approve-1",
		});
		const approved = await client.approvePlanAssignments({
			runId: "home-plan-approve-1",
			approvalNote: "Approved from Home validation test",
		});
		await Promise.all(context.waitUntilPromises);

		expect(proposed.homePlan?.assignments).toHaveLength(2);
		expect(approved.homePlan.status).toBe("dispatching");
		expect(approved.assignments).toHaveLength(2);
		expect(approved.assignments.map((assignment) => assignment.status)).toEqual(
			["queued", "queued"],
		);
		expect(db.workItemRows).toHaveLength(2);
		expect(db.workItemRows.map((item) => item.accountableOwnerId)).toEqual([
			"tedi-cpo",
			"tedi-echo",
		]);
		expect(db.workItemCommentRows).toHaveLength(2);
		expect(delegateRunner).toHaveBeenCalledTimes(2);
		expect(delegateRunner.mock.calls[0]?.[0]).toMatchObject({
			delegateToTediId: "tedi-cpo",
			metadata: {
				homePlanAssignmentId: proposed.homePlan?.assignments[0]?.id,
				workItemId: db.workItemRows[0]?.id,
			},
		});
		expect(db.workItemRows[0]?.description).toContain(
			"Assignment scope is authoritative: execute and report only the objective above.",
		);
		expect(db.workItemRows[0]?.description).toContain(
			"Original Home request (supporting context only):",
		);
		expect(db.workItemRows[0]?.description).toContain(originalRequest);
		for (const item of db.workItemRows)
			expect(item.description).toContain(originalRequest);
		for (const [dispatch] of delegateRunner.mock.calls)
			expect(dispatch.content).toContain(originalRequest);
		for (const assignment of proposed.homePlan?.assignments ?? [])
			expect(assignment.objective.length).toBeLessThanOrEqual(600);
		expect(delegateRunner.mock.calls[0]?.[0].content).toContain(
			"Assignment scope is authoritative: execute and report only the objective above.",
		);
		expect(delegateRunner.mock.calls[0]?.[0].content).toContain(
			"Do not perform, summarize, or claim completion of another owner's objective",
		);
		expect(delegateRunner.mock.calls[0]?.[0].content).toContain(
			"Original Home request (supporting context only):",
		);
		expect(delegateRunner.mock.calls[0]?.[0].content).toContain(
			originalRequest,
		);
		expect(
			db.events.some(
				(event) =>
					event.kind === "decision.recorded" &&
					(event.payload as { action?: string } | null)?.action ===
						"home.plan.approved",
			),
		).toBe(true);
		expect(db.runs[0]?.metadata).toMatchObject({
			homePlan: {
				status: "dispatching",
				assignments: [
					{
						status: "queued",
						workItemId: db.workItemRows[0]?.id,
					},
					{
						status: "queued",
						workItemId: db.workItemRows[1]?.id,
					},
				],
			},
		});
	});

	it("materializes inferred plan dependencies into work_item_relations and defers the dependent on dispatch", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const client = createKernelRuntimeClient(context);
		const delegateRunner = vi.fn(async (input) => ({
			childConversationId: "agent:main:main",
			childRunId: `${input.delegateToTediId}:mcp:${input.childRunId.replaceAll(":", "_")}`,
			status: "queued" as const,
		}));
		kernelRuntimeTestHooks.setDelegateRunnerForTest(delegateRunner);

		// CTO (blocker) must finish before CMO (dependent).
		seedDependencyPlanRun(db, {
			runId: "home-plan-deps-1",
			assignments: [
				planAssignmentSeed({
					id: "assign-cto",
					ownerTediId: "tedi-cto",
					ownerLabel: "CTO",
				}),
				planAssignmentSeed({
					id: "assign-cmo",
					ownerTediId: "tedi-cmo",
					ownerLabel: "CMO",
				}),
			],
			dependencies: [
				{
					fromOwnerTediId: "tedi-cto",
					toOwnerTediId: "tedi-cmo",
					reason: "CMO waits on CTO's deploy gate.",
				},
			],
		});

		const approved = await client.approvePlanAssignments({
			runId: "home-plan-deps-1",
			approvalNote: "Approved with a CTO→CMO dependency",
		});
		await Promise.all(context.waitUntilPromises);

		const ctoWorkItem = db.workItemRows.find(
			(item) => item.accountableOwnerId === "tedi-cto",
		);
		const cmoWorkItem = db.workItemRows.find(
			(item) => item.accountableOwnerId === "tedi-cmo",
		);
		expect(ctoWorkItem).toBeDefined();
		expect(cmoWorkItem).toBeDefined();

		// (a) the inferred edge became a canonical blocks relation, blocker→dependent.
		expect(db.workItemRelationRows).toHaveLength(1);
		expect(db.workItemRelationRows[0]).toMatchObject({
			relationType: "blocks",
			fromWorkItemId: ctoWorkItem?.id,
			toWorkItemId: cmoWorkItem?.id,
		});
		expect(db.workItemRelationRows[0]?.metadata).toMatchObject({
			source: "kernelRuntime.plan.inferredDependency",
			homePlanId: "home-plan-deps-1:plan",
		});

		// (b) the shipped blocker query reads CTO as a blocker of CMO.
		const blockers = await queryWorkItemBlockers(
			db as never,
			cmoWorkItem?.id ?? "",
		);
		expect(blockers.map((blocker) => blocker.id)).toContain(ctoWorkItem?.id);
		// findWorkItemsBlockedBy is the inverse: CMO is a dependent of CTO.
		const dependents = await findWorkItemsBlockedBy(
			db as never,
			ctoWorkItem?.id ?? "",
		);
		expect(dependents.map((dependent) => dependent.id)).toContain(
			cmoWorkItem?.id,
		);

		// (c) CTO dispatches; CMO stays approved (deferred) with a blocked_by_dependency note.
		const ctoResult = approved.assignments.find(
			(assignment) => assignment.ownerTediId === "tedi-cto",
		);
		const cmoResult = approved.assignments.find(
			(assignment) => assignment.ownerTediId === "tedi-cmo",
		);
		expect(ctoResult?.status).toBe("queued");
		expect(cmoResult?.status).toBe("approved");
		expect(delegateRunner).toHaveBeenCalledTimes(1);
		expect(delegateRunner.mock.calls[0]?.[0]).toMatchObject({
			delegateToTediId: "tedi-cto",
		});
		expect(
			db.workItemCommentRows.some(
				(comment) =>
					(comment.metadata as { source?: string }).source ===
						"kernelRuntime.approvePlanAssignments" &&
					comment.workItemId === cmoWorkItem?.id,
			),
		).toBe(true);
	});

	it("a thrown child dispatch persists status 'failed' identically in the parallel and serialized fan-out paths", async () => {
		// A dispatch that throws (e.g. runtime_unavailable) must persist the same
		// assignment status regardless of whether the plan carries a cross-tedi
		// dependency edge (serialized path) or not (parallel path). Previously the
		// parallel path deferred dispatch settlement to a post-persist
		// context.waitUntil, so the run row was written with the optimistic "queued"
		// status (and a predicted childRunId that never settles) while the serialized
		// path — which awaits each child in-loop before persist — captured "failed".
		// Same failure, divergent persisted state, split only on an unrelated edge.
		// The mock is async so kernelDelegateRunner returns a rejected promise (as the
		// real runner does on a failed enqueue) that the in-code `.catch` handles.
		const throwOnCto = async (input: { delegateToTediId: string }) => {
			if (input.delegateToTediId === "tedi-cto") {
				throw new Error("runtime_unavailable");
			}
			return {
				childConversationId: "agent:main:main",
				childRunId: `child:${input.delegateToTediId}`,
				status: "queued" as const,
			};
		};

		const persistedStatusFor = (
			db: ReturnType<typeof createKernelRuntimeDb>,
			runId: string,
			ownerTediId: string,
		) => {
			const run = db.runs.find((row) => row.id === runId);
			const plan = (
				run?.metadata as {
					homePlan?: {
						assignments: Array<{
							ownerTediId: string;
							status: string;
							error?: string | null;
						}>;
					};
				} | null
			)?.homePlan;
			return plan?.assignments.find(
				(assignment) => assignment.ownerTediId === ownerTediId,
			);
		};

		// (1) Parallel path — two independent assignments, no dependency edge. Both
		// dispatch in parallel; the tedi-cto dispatch throws.
		const parallelDb = createKernelRuntimeDb();
		const parallelContext = createContext(parallelDb);
		const parallelClient = createKernelRuntimeClient(parallelContext);
		kernelRuntimeTestHooks.setDelegateRunnerForTest(vi.fn(throwOnCto));
		seedDependencyPlanRun(parallelDb, {
			runId: "home-plan-parallel-fail-1",
			assignments: [
				planAssignmentSeed({
					id: "assign-cto",
					ownerTediId: "tedi-cto",
					ownerLabel: "CTO",
				}),
				planAssignmentSeed({
					id: "assign-echo",
					ownerTediId: "tedi-echo",
					ownerLabel: "Echo",
				}),
			],
			dependencies: [],
		});
		const parallelApproved = await parallelClient.approvePlanAssignments({
			runId: "home-plan-parallel-fail-1",
			approvalNote: "Approve independent fan-out",
		});
		await Promise.all(parallelContext.waitUntilPromises);

		// (2) Serialized path — same failing owner is the blocker of a dependent, so
		// the plan carries a dependency edge and dispatches sequentially. The
		// tedi-cto dispatch throws; the dependent (tedi-cmo) is deferred.
		const serialDb = createKernelRuntimeDb();
		const serialContext = createContext(serialDb);
		const serialClient = createKernelRuntimeClient(serialContext);
		kernelRuntimeTestHooks.setDelegateRunnerForTest(vi.fn(throwOnCto));
		seedDependencyPlanRun(serialDb, {
			runId: "home-plan-serial-fail-1",
			assignments: [
				planAssignmentSeed({
					id: "assign-cto",
					ownerTediId: "tedi-cto",
					ownerLabel: "CTO",
				}),
				planAssignmentSeed({
					id: "assign-cmo",
					ownerTediId: "tedi-cmo",
					ownerLabel: "CMO",
				}),
			],
			dependencies: [
				{
					fromOwnerTediId: "tedi-cto",
					toOwnerTediId: "tedi-cmo",
					reason: "CMO waits on CTO.",
				},
			],
		});
		const serialApproved = await serialClient.approvePlanAssignments({
			runId: "home-plan-serial-fail-1",
			approvalNote: "Approve coordination-dependent fan-out",
		});
		await Promise.all(serialContext.waitUntilPromises);

		// Parity: the same thrown dispatch persists "failed" in both paths.
		const parallelCto = persistedStatusFor(
			parallelDb,
			"home-plan-parallel-fail-1",
			"tedi-cto",
		);
		const serialCto = persistedStatusFor(
			serialDb,
			"home-plan-serial-fail-1",
			"tedi-cto",
		);
		expect(serialCto?.status).toBe("failed");
		expect(parallelCto?.status).toBe("failed");
		expect(parallelCto?.status).toBe(serialCto?.status);
		expect(parallelCto?.error).toContain("runtime_unavailable");

		// The successful independent sibling still persists "queued" — the fix is
		// scoped to the failed dispatch, not a blanket downgrade.
		const parallelEcho = persistedStatusFor(
			parallelDb,
			"home-plan-parallel-fail-1",
			"tedi-echo",
		);
		expect(parallelEcho?.status).toBe("queued");

		// The API return value and event payload agree with the persisted plan.
		expect(
			parallelApproved.assignments.find(
				(assignment) => assignment.ownerTediId === "tedi-cto",
			)?.status,
		).toBe("failed");
		expect(
			serialApproved.assignments.find(
				(assignment) => assignment.ownerTediId === "tedi-cto",
			)?.status,
		).toBe("failed");
	});

	it("a write-bearing multi-tedi fan-out is chained, not raced (only the chain head dispatches)", async () => {
		// Three independent write-bearing assignments (no dependency edges) — the
		// "no cross-facet write races" case. shouldSerializeFanOut flags this
		// (writeBearingCount 3 > 1). The old serialized branch only `await`ed the
		// async delegate enqueue, which resolves once the child turn is queued, not
		// when its work runs — so all three still dispatched and executed concurrently
		// in their own runtimes, racing on shared state. The fix chains the fan-out
		// into one line of blocker edges so the blocker gate defers all but the single
		// chain head: exactly one child dispatches this turn and the unblock watcher
		// advances the rest one at a time. Pre-fix this expected 3 dispatches.
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const client = createKernelRuntimeClient(context);
		const delegateRunner = vi.fn(async (input) => ({
			childConversationId: "agent:main:main",
			childRunId: `${input.delegateToTediId}:mcp:${input.childRunId.replaceAll(":", "_")}`,
			status: "queued" as const,
		}));
		kernelRuntimeTestHooks.setDelegateRunnerForTest(delegateRunner);

		// A write-bearing objective (mutation verb) makes each assignment count toward
		// writeBearingCount without needing a workstation/workflow route.
		const writeBearing = (
			seed: ReturnType<typeof planAssignmentSeed>,
			objective: string,
		) => ({
			...seed,
			objective,
		});

		seedDependencyPlanRun(db, {
			runId: "home-plan-write-race",
			assignments: [
				writeBearing(
					planAssignmentSeed({
						id: "assign-cto",
						ownerTediId: "tedi-cto",
						ownerLabel: "CTO",
					}),
					"Deploy the shared config bundle",
				),
				writeBearing(
					planAssignmentSeed({
						id: "assign-cmo",
						ownerTediId: "tedi-cmo",
						ownerLabel: "CMO",
					}),
					"Update the shared campaign ledger",
				),
				writeBearing(
					planAssignmentSeed({
						id: "assign-cpo",
						ownerTediId: "tedi-cpo",
						ownerLabel: "CPO",
					}),
					"Publish the shared roadmap doc",
				),
			],
			dependencies: [],
		});

		const approved = await client.approvePlanAssignments({
			runId: "home-plan-write-race",
			approvalNote: "Approved an independent write-bearing fan-out",
		});
		await Promise.all(context.waitUntilPromises);

		const ctoWorkItem = db.workItemRows.find(
			(item) => item.accountableOwnerId === "tedi-cto",
		);
		const cmoWorkItem = db.workItemRows.find(
			(item) => item.accountableOwnerId === "tedi-cmo",
		);
		const cpoWorkItem = db.workItemRows.find(
			(item) => item.accountableOwnerId === "tedi-cpo",
		);

		// (a) The fix: exactly one child dispatches — the chain head. Pre-fix all
		// three write-bearing members dispatched and raced (this asserted 3).
		expect(delegateRunner).toHaveBeenCalledTimes(1);
		expect(delegateRunner.mock.calls[0]?.[0]).toMatchObject({
			delegateToTediId: "tedi-cto",
		});

		// (b) the other two write-bearing members stay approved (deferred by the gate)
		// with a blocker note — they run only after the head completes.
		const statusFor = (ownerTediId: string) =>
			approved.assignments.find(
				(assignment) => assignment.ownerTediId === ownerTediId,
			)?.status;
		expect(statusFor("tedi-cto")).toBe("queued");
		expect(statusFor("tedi-cmo")).toBe("approved");
		expect(statusFor("tedi-cpo")).toBe("approved");
		for (const deferred of [cmoWorkItem, cpoWorkItem]) {
			expect(
				db.workItemCommentRows.some(
					(comment) =>
						(comment.metadata as { source?: string }).source ===
							"kernelRuntime.approvePlanAssignments" &&
						comment.workItemId === deferred?.id,
				),
			).toBe(true);
		}

		// (c) the serialization is real: two synthetic chain edges (CTO→CMO→CPO), a
		// linear extension over the otherwise edgeless set, single-thread the whole
		// fan-out through the existing blocker gate + unblock watcher.
		const chainEdges = db.workItemRelationRows.filter(
			(row) =>
				(row.metadata as { source?: string } | null)?.source ===
				"kernelRuntime.plan.serializedFanOut",
		);
		expect(chainEdges).toHaveLength(2);
		expect(chainEdges).toContainEqual(
			expect.objectContaining({
				relationType: "blocks",
				fromWorkItemId: ctoWorkItem?.id,
				toWorkItemId: cmoWorkItem?.id,
			}),
		);
		expect(chainEdges).toContainEqual(
			expect.objectContaining({
				relationType: "blocks",
				fromWorkItemId: cmoWorkItem?.id,
				toWorkItemId: cpoWorkItem?.id,
			}),
		);
	});

	it("defers the dependent even when it is listed before its blocker (pre-pass creates all relations before any gate runs)", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const client = createKernelRuntimeClient(context);
		const delegateRunner = vi.fn(async (input) => ({
			childConversationId: "agent:main:main",
			childRunId: `${input.delegateToTediId}:mcp:${input.childRunId.replaceAll(":", "_")}`,
			status: "queued" as const,
		}));
		kernelRuntimeTestHooks.setDelegateRunnerForTest(delegateRunner);

		// Reversed listing: CMO (the dependent) is at index 0, CTO (the blocker)
		// at index 1. The inferred edge is still CTO→CMO (blocker→dependent). A
		// naive interleaved implementation that materialized relations as it
		// processed each assignment would gate CMO at index 0 before CTO's Work
		// Item / relation existed, so it would dispatch CMO. The pre-pass creates
		// all Work Items + all relations first, so the gate sees CTO blocking CMO
		// regardless of listing order.
		seedDependencyPlanRun(db, {
			runId: "home-plan-deps-reordered",
			assignments: [
				planAssignmentSeed({
					id: "assign-cmo",
					ownerTediId: "tedi-cmo",
					ownerLabel: "CMO",
				}),
				planAssignmentSeed({
					id: "assign-cto",
					ownerTediId: "tedi-cto",
					ownerLabel: "CTO",
				}),
			],
			dependencies: [
				{
					fromOwnerTediId: "tedi-cto",
					toOwnerTediId: "tedi-cmo",
					reason: "CMO waits on CTO's deploy gate.",
				},
			],
		});

		const approved = await client.approvePlanAssignments({
			runId: "home-plan-deps-reordered",
			approvalNote:
				"Approved with a CTO→CMO dependency (dependent listed first)",
		});
		await Promise.all(context.waitUntilPromises);

		const ctoWorkItem = db.workItemRows.find(
			(item) => item.accountableOwnerId === "tedi-cto",
		);
		const cmoWorkItem = db.workItemRows.find(
			(item) => item.accountableOwnerId === "tedi-cmo",
		);
		expect(ctoWorkItem).toBeDefined();
		expect(cmoWorkItem).toBeDefined();

		// (c) the inferred edge materialized as a canonical blocks relation,
		// blocker→dependent (CTO Work Item → CMO Work Item).
		expect(db.workItemRelationRows).toHaveLength(1);
		expect(db.workItemRelationRows[0]).toMatchObject({
			relationType: "blocks",
			fromWorkItemId: ctoWorkItem?.id,
			toWorkItemId: cmoWorkItem?.id,
		});

		// (a) only the blocker (CTO) dispatches — exactly once — even though the
		// dependent (CMO) was processed first in listing order.
		const ctoResult = approved.assignments.find(
			(assignment) => assignment.ownerTediId === "tedi-cto",
		);
		const cmoResult = approved.assignments.find(
			(assignment) => assignment.ownerTediId === "tedi-cmo",
		);
		expect(ctoResult?.status).toBe("queued");
		expect(delegateRunner).toHaveBeenCalledTimes(1);
		expect(delegateRunner.mock.calls[0]?.[0]).toMatchObject({
			delegateToTediId: "tedi-cto",
		});

		// (b) the dependent (CMO) stays approved (deferred by the gate) and carries
		// a blocked_by_dependency note rather than dispatching.
		expect(cmoResult?.status).toBe("approved");
		expect(
			db.workItemCommentRows.some(
				(comment) =>
					(comment.metadata as { source?: string }).source ===
						"kernelRuntime.approvePlanAssignments" &&
					comment.workItemId === cmoWorkItem?.id,
			),
		).toBe(true);
	});

	it("re-approving a dependency plan does not duplicate the work_item_relations row", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const client = createKernelRuntimeClient(context);
		kernelRuntimeTestHooks.setDelegateRunnerForTest(async (input) => ({
			childConversationId: "agent:main:main",
			childRunId: `${input.delegateToTediId}:mcp:${input.childRunId.replaceAll(":", "_")}`,
			status: "queued" as const,
		}));

		seedDependencyPlanRun(db, {
			runId: "home-plan-deps-idem",
			assignments: [
				planAssignmentSeed({
					id: "assign-cto",
					ownerTediId: "tedi-cto",
					ownerLabel: "CTO",
				}),
				planAssignmentSeed({
					id: "assign-cmo",
					ownerTediId: "tedi-cmo",
					ownerLabel: "CMO",
				}),
			],
			dependencies: [
				{
					fromOwnerTediId: "tedi-cto",
					toOwnerTediId: "tedi-cmo",
					reason: "CMO waits on CTO.",
				},
			],
		});

		// Explicit assignmentIds so the second pass re-selects both owners (their
		// status is no longer "proposed" after the first approval). createWorkItem
		// upserts on (orgId, sourceIntentId), so the Work Item ids are stable across
		// re-approvals — addWorkItemRelation then collides on its unique index.
		await client.approvePlanAssignments({
			runId: "home-plan-deps-idem",
			assignmentIds: ["assign-cto", "assign-cmo"],
		});
		await Promise.all(context.waitUntilPromises);
		await client.approvePlanAssignments({
			runId: "home-plan-deps-idem",
			assignmentIds: ["assign-cto", "assign-cmo"],
		});
		await Promise.all(context.waitUntilPromises);

		expect(db.workItemRelationRows).toHaveLength(1);
		expect(db.workItemRows).toHaveLength(2);
	});

	it("survives a cyclic dependency snapshot fail-soft without throwing", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const client = createKernelRuntimeClient(context);
		kernelRuntimeTestHooks.setDelegateRunnerForTest(async (input) => ({
			childConversationId: "agent:main:main",
			childRunId: `${input.delegateToTediId}:mcp:${input.childRunId.replaceAll(":", "_")}`,
			status: "queued" as const,
		}));

		// The planner prunes cycles, but a corrupt/forged snapshot could carry one.
		// Both edges materialize; each owner blocks the other, so both defer — and
		// crucially the approval completes without throwing.
		seedDependencyPlanRun(db, {
			runId: "home-plan-deps-cycle",
			assignments: [
				planAssignmentSeed({
					id: "assign-cto",
					ownerTediId: "tedi-cto",
					ownerLabel: "CTO",
				}),
				planAssignmentSeed({
					id: "assign-cmo",
					ownerTediId: "tedi-cmo",
					ownerLabel: "CMO",
				}),
			],
			dependencies: [
				{
					fromOwnerTediId: "tedi-cto",
					toOwnerTediId: "tedi-cmo",
					reason: "CMO waits on CTO.",
				},
				{
					fromOwnerTediId: "tedi-cmo",
					toOwnerTediId: "tedi-cto",
					reason: "CTO waits on CMO.",
				},
			],
		});

		const approved = await client.approvePlanAssignments({
			runId: "home-plan-deps-cycle",
		});
		await Promise.all(context.waitUntilPromises);

		expect(db.workItemRelationRows).toHaveLength(2);
		// Deadlocked but fail-soft: nothing dispatched, both stay approved.
		expect(
			approved.assignments.every(
				(assignment) => assignment.status === "approved",
			),
		).toBe(true);
		expect(
			db.workItemCommentRows.filter(
				(comment) =>
					(comment.metadata as { source?: string }).source ===
					"kernelRuntime.approvePlanAssignments",
			),
		).toHaveLength(2);
	});

	it("reconciles approved Home plan assignment completions into Work Items and Home messages", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const client = createKernelRuntimeClient(context);
		kernelRuntimeTestHooks.setDelegateRunnerForTest(async (input) => ({
			childConversationId: "agent:main:main",
			childRunId: `${input.delegateToTediId}:mcp:${input.childRunId.replaceAll(":", "_")}`,
			status: "queued",
		}));

		const proposed = await client.enqueueMessage({
			conversationId: "home:test",
			content:
				"Plan this across CPO and Echo: CPO owns launch criteria and Echo validates evidence.",
			idempotencyKey: "home-plan-terminal-1",
		});
		await client.approvePlanAssignments({
			runId: "home-plan-terminal-1",
		});
		await Promise.all(context.waitUntilPromises);
		const cpoAssignment = proposed.homePlan?.assignments[0];
		const echoAssignment = proposed.homePlan?.assignments[1];

		db.runtimeEvents.push(
			childRuntimeEvent({
				createdAt: "2026-06-06T08:02:00.000Z",
				id: "runtime-plan-cpo-completed",
				kind: "run.completed",
				payload: {
					status: "completed",
					content: "CPO launch criteria proof.",
				},
				runId: "tedi-cpo:mcp:home-plan-terminal-1_plan_1_delegate_tedi-cpo",
				tediId: "tedi-cpo",
			}),
			childRuntimeEvent({
				createdAt: "2026-06-06T08:03:00.000Z",
				id: "runtime-plan-echo-completed",
				kind: "run.completed",
				payload: {
					status: "completed",
					content: "Echo evidence validation proof.",
				},
				runId: "tedi-echo:mcp:home-plan-terminal-1_plan_2_delegate_tedi-echo",
				tediId: "tedi-echo",
			}),
		);

		const result = await client.readRunSet({
			conversationId: "home:test",
			limit: 10,
		});

		expect(result.runSet.activeRunIds).toEqual(["home-plan-terminal-1"]);
		expect(result.runSet.runs[0]).toMatchObject({
			id: "home-plan-terminal-1",
			status: "running",
			outputMessageId: "home-plan-terminal-1:assistant",
			progress: {
				current: 100,
				label: "Complete",
			},
			metadata: {
				homePlanConvergencePending: true,
				homePlan: {
					status: "completed",
					assignments: [
						{
							id: cpoAssignment?.id,
							status: "completed",
							workItemId: db.workItemRows[0]?.id,
						},
						{
							id: echoAssignment?.id,
							status: "completed",
							workItemId: db.workItemRows[1]?.id,
						},
					],
				},
			},
		});
		expect(db.workItemRows.map((item) => item.disposition)).toEqual([
			"accepted",
			"accepted",
		]);
		expect(db.workAttemptRows.map((attempt) => attempt.runtimeState)).toEqual([
			"finished",
			"finished",
		]);
		expect(
			db.workItemCommentRows.filter((comment) =>
				comment.id.includes(":home-plan-terminal:completed"),
			),
		).toHaveLength(2);
		expect(
			db.events
				.filter((event) =>
					event.messageId?.includes(":async-completion:assistant"),
				)
				.map((event) => ({
					content: (event.payload as { content?: string } | null)?.content,
					delegatedTediId: event.delegatedTediId,
				})),
		).toEqual(
			expect.arrayContaining([
				{
					content:
						"CPO finished the approved Home assignment. Latest evidence: CPO launch criteria proof.",
					delegatedTediId: "tedi-cpo",
				},
				{
					content:
						"Echo (Isolate) finished the approved Home assignment. Latest evidence: Echo evidence validation proof.",
					delegatedTediId: "tedi-echo",
				},
			]),
		);

		await client.readRunSet({ conversationId: "home:test", limit: 10 });
		expect(
			db.workItemCommentRows.filter((comment) =>
				comment.id.includes(":home-plan-terminal:completed"),
			),
		).toHaveLength(2);

		const messages = await client.readMessages({
			conversationId: "home:test",
			limit: 20,
		});
		expect(
			messages.messages.filter((message) =>
				message.id.includes(":async-completion:assistant"),
			),
		).toHaveLength(0);
		expect(
			messages.messages.find((message) =>
				message.id.includes(":plan-convergence:assistant"),
			),
		).toBeUndefined();
	});

	it("dedupes retries by the Home idempotency key", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));

		await client.enqueueMessage({
			conversationId: "home:test",
			content: "First submit",
			idempotencyKey: "home-retry-1",
		});
		await client.enqueueMessage({
			conversationId: "home:test",
			content: "Retried submit",
			idempotencyKey: "home-retry-1",
		});

		const messages = await client.readMessages({
			conversationId: "home:test",
			limit: 10,
		});
		expect(messages.messages).toHaveLength(2);
		expect(messages.messages.map((message) => message.id)).toEqual([
			"home-retry-1:input",
			"home-retry-1:assistant",
		]);
	});

	it("delegates explicit Home turns through a linked child tedi run", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		kernelRuntimeTestHooks.setDelegateRunnerForTest(async (input) => ({
			childConversationId: "agent:main:main",
			childRunId: input.childRunId,
			status: "queued",
		}));

		const result = await client.enqueueMessage({
			conversationId: "home:test",
			content: "Ask the CPO to validate the deploy plan",
			delegateToTediId: "tedi-cpo",
			idempotencyKey: "home-delegate-1",
		});

		// The linked child id now comes from the settled dispatch result rather
		// than an optimistic prediction, so the run row can never reference a
		// child the runtime never minted.
		expect(result).toMatchObject({
			status: "queued",
			run: {
				delegatedTediId: "tedi-cpo",
				childRunId: "home-delegate-1:delegate:tedi-cpo",
			},
			assistantMessage: {
				content: expect.stringContaining("delegated this Home turn"),
			},
		});
		expect(
			db.events.some(
				(event) =>
					event.delegatedTediId === "tedi-cpo" &&
					event.childRunId === "home-delegate-1:delegate:tedi-cpo",
			),
		).toBe(true);
		// The directed-delegation insert synthesizes a `kernelRoute` (gated on
		// `delegateToTediId`): a directed `queued` run never runs the route planner
		// and is never patched by the `WHERE status="running"` writer-back, so this
		// is the only place the Tedix OS rail's decision chip gets a route to render.
		expect(db.runs[0]?.metadata).toMatchObject({
			delegationWorkOrder: {
				kind: "tedi.delegate",
				targetTediId: "tedi-cpo",
				executionRequirement: {
					surface: "native",
					fallbackSurface: "workstation",
				},
			},
			kernelRoute: {
				routeKind: "delegate_tedi",
				source: "explicit",
				confidence: 1,
				risk: "low",
			},
		});
	});

	it("settles the delegated isolate dispatch before returning the Home receipt", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db) as BaseContext & {
			waitUntilPromises: Promise<unknown>[];
		};
		const client = createKernelRuntimeClient(context);
		let finishDelegate: (() => void) | null = null;
		const delegateStarted = vi.fn();
		kernelRuntimeTestHooks.setDelegateRunnerForTest(
			(input) =>
				new Promise((resolve) => {
					delegateStarted(input.childRunId);
					finishDelegate = () =>
						resolve({
							childConversationId: "agent:main:main",
							childRunId: input.childRunId,
							status: "queued",
						});
				}),
		);

		const pending = client.enqueueMessage({
			conversationId: "home:test",
			content: "Ask the CPO and settle the handoff first",
			delegateToTediId: "tedi-cpo",
			idempotencyKey: "home-nonblocking-delegate-1",
		});

		// Let the turn run up to the dispatch, which then parks on finishDelegate.
		for (
			let tick = 0;
			tick < 50 && !delegateStarted.mock.calls.length;
			tick++
		) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		expect(delegateStarted).toHaveBeenCalledWith(
			"home-nonblocking-delegate-1:delegate:tedi-cpo",
		);

		// The receipt must not resolve while that dispatch is still in flight.
		// Deferring the handoff to waitUntil is what let an isolate eviction take
		// the inject, the ledger seed-writes and the failure recorder with it
		// while the operator was told the work had been delegated.
		const settledEarly = await Promise.race([
			pending.then(() => "resolved" as const),
			new Promise<"still-pending">((resolve) =>
				setTimeout(() => resolve("still-pending"), 20),
			),
		]);
		expect(settledEarly).toBe("still-pending");

		finishDelegate?.();
		const result = await pending;

		// Only the ledger admission and the auto-title dispatch remain on the
		// background queue; the dispatch itself is no longer there.
		expect(context.waitUntilPromises).toHaveLength(1);
		expect(result).toMatchObject({
			status: "queued",
			run: {
				childRunId: "home-nonblocking-delegate-1:delegate:tedi-cpo",
			},
		});
		await Promise.all(context.waitUntilPromises);
	});

	it("reports a terminal Home failure in-band when isolate dispatch fails", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db) as BaseContext & {
			waitUntilPromises: Promise<unknown>[];
		};
		const client = createKernelRuntimeClient(context);
		kernelRuntimeTestHooks.setDelegateRunnerForTest(async (input) => ({
			childConversationId: "agent:main:main",
			childRunId: input.childRunId,
			error: "isolate dispatch unavailable",
			status: "failed",
		}));

		const result = await client.enqueueMessage({
			conversationId: "home:test",
			content: "Ask CPO and surface dispatch failure",
			delegateToTediId: "tedi-cpo",
			idempotencyKey: "home-delegate-fail-1",
		});

		// The failure is known before the operator is answered, so the receipt
		// says "failed" instead of claiming the turn was delegated.
		expect(result.status).toBe("failed");
		await Promise.all(context.waitUntilPromises);

		const runSet = await client.readRunSet({
			conversationId: "home:test",
			limit: 10,
		});
		const run = runSet.runSet.runs.find(
			(candidate) => candidate.id === "home-delegate-fail-1",
		);
		expect(run).toMatchObject({
			id: "home-delegate-fail-1",
			status: "failed",
			progress: {
				label: "Failed",
			},
			metadata: {
				childRunStatus: "failed",
				delegationFailure: {
					ok: false,
					status: "failed",
					reason: "dispatch_failed",
					error: "isolate dispatch unavailable",
					retryable: true,
					childStillRunning: false,
				},
			},
		});

		// Summary mode: same runs, metadata bags and the
		// approval-mirror projection shed — a scanning agent keeps identity,
		// status, timing, and progress without the per-run JSON bulk.
		const compactSet = await client.readRunSet({
			conversationId: "home:test",
			limit: 10,
			summary: true,
		});
		const compactRun = compactSet.runSet.runs.find(
			(candidate) => candidate.id === "home-delegate-fail-1",
		);
		expect(compactRun).toMatchObject({
			id: "home-delegate-fail-1",
			status: "failed",
			progress: { label: "Failed" },
		});
		expect(compactRun?.metadata).toBeUndefined();
		expect(compactSet.runSet.approvalMirrors).toBeUndefined();

		const messages = await client.readMessages({
			conversationId: "home:test",
			limit: 10,
		});
		// One delegation = one row: the dispatch-failure turn's prose was a
		// template over (status, preview) and the turn ahead of it already
		// carries this child run's delegation metadata — the row Tedix OS builds the
		// receipt from — so the restatement no longer renders as its own turn.
		expect(
			messages.messages.some((message) =>
				message.id.includes("async-completion"),
			),
		).toBe(false);
		// The failure is not lost: it lands on the surviving delegation turn's
		// metadata, which is exactly what the receipt row renders (status label
		// + error + preview).
		const delegationTurn = messages.messages.find(
			(message) => message.role === "assistant" && message.childRunId != null,
		);
		expect(delegationTurn).toMatchObject({
			role: "assistant",
			delegatedTediId: "tedi-cpo",
			metadata: {
				metadata: {
					childRunStatus: "failed",
					delegationFailure: {
						ok: false,
						status: "failed",
						reason: "dispatch_failed",
						error: "isolate dispatch unavailable",
						retryable: true,
						childStillRunning: false,
					},
				},
			},
		});
		// The prose stays verbatim in the append-only ledger — only the rendered
		// transcript collapses it.
		const ledgerRow = db.events.find((event) =>
			event.id.includes("delegation-dispatch-failed"),
		);
		expect(
			(ledgerRow?.payload as { content?: string } | null)?.content,
		).toContain("assignment failed");
		expect(
			(
				(ledgerRow?.payload as { metadata?: Record<string, unknown> } | null)
					?.metadata ?? {}
			).homeNarration,
		).toBe("delegation_status_only");
	});

	it("reconciles stale delegated isolate dispatch rows into terminal Home failures", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db) as BaseContext & {
			waitUntilPromises: Promise<unknown>[];
		};
		const client = createKernelRuntimeClient(context);
		kernelRuntimeTestHooks.setDelegateRunnerForTest(async (input) => ({
			childConversationId: "agent:main:main",
			childRunId: input.childRunId,
			status: "queued",
		}));

		const result = await client.enqueueMessage({
			conversationId: "home:test",
			content: "Ask CPO and reconcile if child dispatch never publishes",
			delegateToTediId: "tedi-cpo",
			idempotencyKey: "home-delegate-stale-1",
		});

		expect(result.status).toBe("queued");
		await Promise.all(context.waitUntilPromises);
		const runRow = db.runs.find((candidate) => candidate.id === result.run.id);
		expect(runRow).toBeTruthy();
		Object.assign(runRow ?? {}, {
			createdAt: "2000-01-01T00:00:00.000Z",
			startedAt: "2000-01-01T00:00:00.000Z",
			updatedAt: "2000-01-01T00:00:00.000Z",
		});

		const runSet = await client.readRunSet({
			conversationId: "home:test",
			limit: 10,
		});
		const run = runSet.runSet.runs.find(
			(candidate) => candidate.id === "home-delegate-stale-1",
		);
		expect(run).toMatchObject({
			id: "home-delegate-stale-1",
			status: "failed",
			progress: {
				label: "Failed",
			},
			metadata: {
				childRunStatus: "failed",
				delegationFailure: {
					ok: false,
					status: "failed",
					reason: "dispatch_failed",
					error:
						"Delegated child dispatch timed out before the child runtime published events",
					retryable: true,
					childStillRunning: false,
				},
				source: "kernelRuntime.delegateDispatch",
			},
		});

		const messages = await client.readMessages({
			conversationId: "home:test",
			limit: 10,
		});
		// Prose collapsed into the receipt row; the timeout cause is carried by
		// the structured metadata the receipt renders from, not by a second
		// full-height turn restating it.
		expect(
			messages.messages.some((message) =>
				message.id.includes("async-completion"),
			),
		).toBe(false);
		expect(
			messages.messages.find(
				(message) => message.role === "assistant" && message.childRunId != null,
			),
		).toMatchObject({
			role: "assistant",
			delegatedTediId: "tedi-cpo",
			metadata: {
				metadata: {
					childRunStatus: "failed",
					delegationFailure: {
						ok: false,
						status: "failed",
						reason: "dispatch_failed",
						error:
							"Delegated child dispatch timed out before the child runtime published events",
						retryable: true,
						childStillRunning: false,
					},
				},
			},
		});
	});

	it("enriches delegated Home messages with child runtime status", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		kernelRuntimeTestHooks.setDelegateRunnerForTest(async (input) => ({
			childConversationId: "agent:main:main",
			childRunId: input.childRunId,
			status: "queued",
		}));

		await client.enqueueMessage({
			conversationId: "home:test",
			content: "Ask the CPO to validate the deploy plan",
			delegateToTediId: "tedi-cpo",
			idempotencyKey: "home-delegate-status-1",
		});
		// Genuine completion: both message.completed (substantive result) and
		// run.completed present so the disposition gate reports completed.
		db.runtimeEvents.push(
			childRuntimeEvent({
				createdAt: "2026-06-06T08:01:00.000Z",
				id: "runtime-child-message-status-1",
				kind: "message.completed",
				payload: { role: "assistant", content: "Deploy plan validated." },
				runId: "tedi-cpo:mcp:home-delegate-status-1_delegate_tedi-cpo",
				tediId: "tedi-cpo",
			}),
			childRuntimeEvent({
				createdAt: "2026-06-06T08:01:01.000Z",
				id: "runtime-child-completed",
				kind: "run.completed",
				payload: { status: "completed" },
				runId: "tedi-cpo:mcp:home-delegate-status-1_delegate_tedi-cpo",
				tediId: "tedi-cpo",
			}),
		);

		const messages = await client.readMessages({
			conversationId: "home:test",
			limit: 10,
		});
		const assistant = messages.messages.find(
			(message) => message.role === "assistant",
		);
		const nestedMetadata = assistant?.metadata?.metadata as
			| Record<string, unknown>
			| undefined;

		expect(nestedMetadata).toMatchObject({
			childRunId: "tedi-cpo:mcp:home-delegate-status-1_delegate_tedi-cpo",
			childRunLatestEventKind: "run.completed",
			childRunStatus: "completed",
		});
	});

	it("settles parent as completed when child has run.failed THEN run.completed (race guard)", async () => {
		// Bug A: a transient run.failed event (e.g. orphan-sweep) followed by a real
		// run.completed for the same child run_id must resolve to completed, not failed.
		// The event rows are DESC-ordered on read; run.completed (chronologically later)
		// appears first so the primary mechanism already handles this, but the race
		// guard in summarizeChildRuntimeEvents also covers the reverse DESC case.
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		kernelRuntimeTestHooks.setDelegateRunnerForTest(async (input) => ({
			childConversationId: "agent:main:main",
			childRunId: input.childRunId,
			status: "queued",
		}));

		await client.enqueueMessage({
			conversationId: "home:test",
			content: "Ask CPO, expect race-guard to protect completion",
			delegateToTediId: "tedi-cpo",
			idempotencyKey: "home-race-guard-1",
		});
		const childRunId = "tedi-cpo:mcp:home-race-guard-1_delegate_tedi-cpo";
		// run.failed appears chronologically first (e.g. transient orphan-sweep at T1)
		// then run.completed at T2 with a real message.completed.
		db.runtimeEvents.push(
			childRuntimeEvent({
				createdAt: "2026-06-06T08:01:00.000Z",
				id: "child-race-failed",
				kind: "run.failed",
				payload: { error: "transient orphan sweep" },
				runId: childRunId,
				tediId: "tedi-cpo",
			}),
			childRuntimeEvent({
				createdAt: "2026-06-06T08:02:00.000Z",
				id: "child-race-message",
				kind: "message.completed",
				payload: { role: "assistant", content: "CPO completed the task." },
				runId: childRunId,
				tediId: "tedi-cpo",
			}),
			childRuntimeEvent({
				createdAt: "2026-06-06T08:02:01.000Z",
				id: "child-race-completed",
				kind: "run.completed",
				payload: null,
				runId: childRunId,
				tediId: "tedi-cpo",
			}),
		);

		const runSet = await client.readRunSet({
			conversationId: "home:test",
			limit: 10,
		});
		const run = runSet.runSet.runs.find(
			(candidate) => candidate.id === "home-race-guard-1",
		);
		expect(run).toMatchObject({
			id: "home-race-guard-1",
			status: "completed",
			metadata: {
				childRunStatus: "completed",
			},
		});
	});

	it("treats run.completed with no substantive result as failed (disposition gate)", async () => {
		// Bug B: a bare run.completed with no message.completed, no artifact.created,
		// and no preview (the dropped-runtime/succeededLost shape) must not surface as
		// a clean completed — it produced no answer, so it should fail so the operator
		// knows to retry rather than seeing an empty work card.
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		kernelRuntimeTestHooks.setDelegateRunnerForTest(async (input) => ({
			childConversationId: "agent:main:main",
			childRunId: input.childRunId,
			status: "queued",
		}));

		await client.enqueueMessage({
			conversationId: "home:test",
			content: "Ask CPO, child drops with empty completion",
			delegateToTediId: "tedi-cpo",
			idempotencyKey: "home-disposition-gate-1",
		});
		const childRunId = "tedi-cpo:mcp:home-disposition-gate-1_delegate_tedi-cpo";
		// Only run.completed with no message.completed, no artifact.created, no
		// substantive payload content — the succeededLost / dropped-runtime shape.
		db.runtimeEvents.push(
			childRuntimeEvent({
				createdAt: "2026-06-06T08:01:00.000Z",
				id: "child-bare-completed",
				kind: "run.completed",
				payload: { status: "completed" },
				runId: childRunId,
				tediId: "tedi-cpo",
			}),
		);

		const runSet = await client.readRunSet({
			conversationId: "home:test",
			limit: 10,
		});
		const run = runSet.runSet.runs.find(
			(candidate) => candidate.id === "home-disposition-gate-1",
		);
		expect(run).toMatchObject({
			id: "home-disposition-gate-1",
			status: "failed",
			metadata: {
				childRunStatus: "failed",
			},
		});
	});

	it("exposes durable Home run-set membership with active child progress", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		kernelRuntimeTestHooks.setDelegateRunnerForTest(async (input) => ({
			childConversationId: "agent:main:main",
			childRunId: input.childRunId,
			status: "queued",
		}));

		await client.enqueueMessage({
			conversationId: "home:test",
			content: "Ask Echo to keep working",
			delegateToTediId: "tedi-echo",
			idempotencyKey: "home-run-set-1",
		});
		db.runtimeEvents.push({
			artifactId: null,
			approvalRequestId: null,
			conversationId: "agent:main:main",
			createdAt: "2026-06-06T08:01:00.000Z",
			delta: null,
			id: "runtime-child-started-run-set",
			kind: "run.started",
			messageId: null,
			organizationId: ORG_ID,
			payload: { status: "running" },
			runId: "tedi-echo:mcp:home-run-set-1_delegate_tedi-echo",
			runtimeBackend: "cloudflare-agents",
			runtimeExternalId: null,
			runtimeExternalUrl: null,
			runtimeMetadata: null,
			sequence: null,
			tediId: "tedi-echo",
			toolCallId: null,
		});

		const result = await client.readRunSet({
			conversationId: "home:test",
			limit: 10,
		});

		expect(result.runSet).toMatchObject({
			activeRunIds: ["home-run-set-1"],
			conversationId: "home:test",
			organizationId: ORG_ID,
			metadata: {
				model: "kernel_runtime_runs",
			},
		});
		expect(result.runSet.runs[0]).toMatchObject({
			id: "home-run-set-1",
			status: "running",
			delegatedTediId: "tedi-echo",
			childRunId: "tedi-echo:mcp:home-run-set-1_delegate_tedi-echo",
			progress: {
				current: 48,
				label: "Running",
			},
			metadata: {
				childRunLatestEventKind: "run.started",
				childRunStatus: "running",
			},
		});
	});

	it("pages durable Home runs by offset newest-first with no overlap", async () => {
		const db = createKernelRuntimeDb();
		// Seed five runs, newest updatedAt last so DESC order is run-5..run-1.
		for (let i = 1; i <= 5; i += 1) {
			db.runs.push(
				normalizeKernelRuntimeRunInsert({
					id: `home-page-${i}`,
					organizationId: ORG_ID,
					conversationId: "home:paged",
					status: "completed",
					createdAt: `2026-06-06T08:0${i}:00.000Z`,
					updatedAt: `2026-06-06T08:0${i}:30.000Z`,
				}),
			);
		}
		const client = createKernelRuntimeClient(createContext(db));

		// No offset = head page, identical to today's behavior.
		const head = await client.readRunSet({
			conversationId: "home:paged",
			limit: 2,
		});
		expect(head.runSet.runs.map((run) => run.id)).toEqual([
			"home-page-5",
			"home-page-4",
		]);

		// offset:0 is equivalent to omitting offset.
		const headExplicit = await client.readRunSet({
			conversationId: "home:paged",
			limit: 2,
			offset: 0,
		});
		expect(headExplicit.runSet.runs.map((run) => run.id)).toEqual([
			"home-page-5",
			"home-page-4",
		]);

		// Second page picks up exactly where the head left off — no overlap.
		const second = await client.readRunSet({
			conversationId: "home:paged",
			limit: 2,
			offset: 2,
		});
		expect(second.runSet.runs.map((run) => run.id)).toEqual([
			"home-page-3",
			"home-page-2",
		]);

		// Third (partial) page returns the tail with no duplicates.
		const third = await client.readRunSet({
			conversationId: "home:paged",
			limit: 2,
			offset: 4,
		});
		expect(third.runSet.runs.map((run) => run.id)).toEqual(["home-page-1"]);

		// Union of all pages covers every run exactly once.
		const seen = [
			...head.runSet.runs,
			...second.runSet.runs,
			...third.runSet.runs,
		].map((run) => run.id);
		expect(new Set(seen).size).toBe(seen.length);
		expect(new Set(seen)).toEqual(
			new Set([
				"home-page-1",
				"home-page-2",
				"home-page-3",
				"home-page-4",
				"home-page-5",
			]),
		);
	});

	it.each(["untracked", "unchecked", "checked", "paused"])(
		"reconciles terminal child status and preserves the source reply (%s)",
		async (mode) => {
			const db = createKernelRuntimeDb();
			const client = createKernelRuntimeClient(createContext(db));
			kernelRuntimeTestHooks.setDelegateRunnerForTest(async (input) => ({
				childConversationId: "agent:main:main",
				childRunId: input.childRunId,
				status: "queued",
			}));

			await client.enqueueMessage({
				conversationId: "home:test",
				content: "Ask Echo to finish",
				delegateToTediId: "tedi-echo",
				idempotencyKey: "home-run-terminal-1",
			});
			const finalAnswer =
				"Echo checked the requested data and found no discrepancies.";
			if (mode !== "untracked") {
				const row = db.runs.find((r) => r.id === "home-run-terminal-1")!;
				row.metadata = {
					...row.metadata,
					kernelRequestId: "home:home-run-terminal-1",
				};
				const request = {
					id: "home:home-run-terminal-1",
					organizationId: ORG_ID,
					ownerUserId: "user-1",
					sourceKind: "home" as const,
					sourceId: row.id,
					conversationId: row.conversationId,
					version: 1,
					snapshot: {
						...receivedKernelRequest(),
						checks:
							mode === "checked"
								? [
										{
											kind: "os_output_revision" as const,
											outputId: "output-one",
											revisionId: "revision-one",
										},
									]
								: [],
					},
					nextOwner: "kernel",
					nextAction: "file_request",
					nextDueAt: row.createdAt,
					lastEventId: "received",
					createdAt: row.createdAt,
					updatedAt: row.createdAt,
				};
				vi.spyOn(
					kernelRequestQueries,
					"getHomeKernelRequest",
				).mockResolvedValue(request);
				vi.spyOn(
					kernelRequestSource,
					"readKernelRequestPolicy",
				).mockResolvedValue(
					mode === "paused"
						? null
						: {
								version: 1,
								enabled: true,
								nextOwner: "kernel",
								retryMs: 1000,
								probeTimeoutMs: 1000,
								maxProbeAttempts: 3,
								runBudgetMs: 1000,
								repositoryTargets: [],
							},
				);
				vi.spyOn(
					kernelRequestSource,
					"reconcileHomeKernelRequest",
				).mockResolvedValue(request);
			}
			db.runtimeEvents.push(
				childRuntimeEvent({
					createdAt: "2026-06-06T08:01:59.000Z",
					id: "runtime-child-final-terminal",
					kind: "message.completed",
					messageId: "echo-terminal-final",
					payload: { role: "assistant", content: finalAnswer },
					runId: "tedi-echo:mcp:home-run-terminal-1_delegate_tedi-echo",
					tediId: "tedi-echo",
				}),
				{
					artifactId: null,
					approvalRequestId: null,
					conversationId: "agent:main:main",
					createdAt: "2026-06-06T08:01:00.000Z",
					delta: null,
					id: "runtime-child-started-terminal",
					kind: "run.started",
					messageId: null,
					organizationId: ORG_ID,
					payload: { status: "running" },
					runId: "tedi-echo:mcp:home-run-terminal-1_delegate_tedi-echo",
					runtimeBackend: "cloudflare-agents",
					runtimeExternalId: null,
					runtimeExternalUrl: null,
					runtimeMetadata: null,
					sequence: null,
					tediId: "tedi-echo",
					toolCallId: null,
				},
				{
					artifactId: null,
					approvalRequestId: null,
					conversationId: "agent:main:main",
					createdAt: "2026-06-06T08:02:00.000Z",
					delta: "Echo terminal proof.",
					id: "runtime-child-completed-terminal",
					kind: "run.completed",
					messageId: null,
					organizationId: ORG_ID,
					payload: { status: "completed", content: "Echo terminal proof." },
					runId: "tedi-echo:mcp:home-run-terminal-1_delegate_tedi-echo",
					runtimeBackend: "cloudflare-agents",
					runtimeExternalId: null,
					runtimeExternalUrl: null,
					runtimeMetadata: null,
					sequence: null,
					tediId: "tedi-echo",
					toolCallId: null,
				},
			);

			const result = await client.readRunSet({
				conversationId: "home:test",
				limit: 10,
			});

			expect(result.runSet.activeRunIds).toEqual([]);
			expect(result.runSet.runs[0]).toMatchObject({
				id: "home-run-terminal-1",
				status: "completed",
				completedAt: "2026-06-06T08:02:00.000Z",
				progress: {
					current: 100,
					label: "Complete",
				},
				metadata: {
					childRunLatestEventKind: "run.completed",
					childRunPreview: finalAnswer,
					childRunStatus: "completed",
				},
			});
			expect(db.runs[0]).toMatchObject({
				id: "home-run-terminal-1",
				status: "completed",
				completedAt: "2026-06-06T08:02:00.000Z",
				latestEventKind: "run.completed",
				latestEventAt: "2026-06-06T08:02:00.000Z",
				preview: finalAnswer,
				progressLabel: "Complete",
				progressValue: 100,
			});
			expect(db.submissionSettleCalls).toContainEqual({
				submissionId: "sub:home-run-terminal-1",
				outcome: "settled",
			});
			expect(db.runs[0]?.outputMessageId).toBe(
				"home-run-terminal-1:async-completion:assistant",
			);
			const completionMessages = db.events.filter(
				(event) =>
					event.messageId === "home-run-terminal-1:async-completion:assistant",
			);
			expect(completionMessages).toHaveLength(1);
			expect(completionMessages[0]).toMatchObject({
				kind: "message.completed",
				conversationId: "home:test",
				delegatedTediId: "tedi-echo",
				childRunId: "tedi-echo:mcp:home-run-terminal-1_delegate_tedi-echo",
				payload: {
					role: "assistant",
					content: finalAnswer,
					metadata: {
						asyncCompletion: true,
						childRunStatus: "completed",
						childRunLatestEventKind: "run.completed",
						source: "kernelRuntime.delegationCompletion",
					},
				},
			});

			expect(completionMessages[0]?.payload?.metadata).not.toHaveProperty(
				"delegationProof",
			);

			db.runs[0]!.outputMessageId = "home-run-terminal-1:acceptance:assistant";
			await client.readRunSet({
				conversationId: "home:test",
				limit: 10,
			});
			expect(db.runs[0]?.outputMessageId).toBe(
				"home-run-terminal-1:async-completion:assistant",
			);
			expect(
				db.events.filter(
					(event) =>
						event.messageId ===
						"home-run-terminal-1:async-completion:assistant",
				),
			).toHaveLength(1);

			const messages = await client.readMessages({
				conversationId: "home:test",
				limit: 10,
			});
			expect(
				messages.messages.find(
					(message) =>
						message.id === "home-run-terminal-1:async-completion:assistant",
				),
			).toMatchObject({
				id: "home-run-terminal-1:async-completion:assistant",
				delegatedTediId: "tedi-echo",
				childRunId: "tedi-echo:mcp:home-run-terminal-1_delegate_tedi-echo",
				role: "assistant",
				content: finalAnswer,
				metadata: {
					metadata: {
						asyncCompletion: true,
						childRunStatus: "completed",
					},
				},
			});
		},
	);

	it("skips live child-evidence queries for terminal runs (fan-out bound)", async () => {
		// 20 delegation runs all in terminal state with their async-completion
		// message already durable (steady state) — none should trigger a
		// tediRuntimeEvents select: the read-repair's deterministic-event-id
		// pre-check must gate the child-evidence read per row. Only kernel-side
		// selects are expected.
		const TERMINAL_COUNT = 20;
		const db = createKernelRuntimeDb();

		// Wrap db.select to count tediRuntimeEvents hits.
		let childEvidenceSelectCount = 0;
		const originalSelect = db.select.bind(db);
		db.select = (() => {
			const builder = originalSelect();
			const originalFrom = builder.from.bind(builder);
			builder.from = (table: unknown) => {
				if (isRuntimeEventSource(table)) childEvidenceSelectCount += 1;
				return originalFrom(table);
			};
			return builder;
		}) as typeof db.select;

		// Seed terminal delegation runs directly (bypass enqueueMessage to keep
		// the run rows terminal from the start — simulating a heavy history).
		for (let i = 0; i < TERMINAL_COUNT; i += 1) {
			const runId = `terminal-run-${i}`;
			const childRunId = `tedi-echo:mcp:${runId}_delegate_tedi-echo`;
			db.runs.push(
				normalizeKernelRuntimeRunInsert({
					id: runId,
					organizationId: ORG_ID,
					conversationId: "home:heavy",
					status: "completed",
					delegatedTediId: "tedi-echo",
					childRunId,
					preview: `Result ${i}`,
					latestEventKind: "run.completed",
					latestEventAt: `2026-06-06T08:${String(i).padStart(2, "0")}:00.000Z`,
					completedAt: `2026-06-06T08:${String(i).padStart(2, "0")}:00.000Z`,
					createdAt: `2026-06-06T08:${String(i).padStart(2, "0")}:00.000Z`,
					updatedAt: `2026-06-06T08:${String(i).padStart(2, "0")}:00.000Z`,
					// Persist childRunStatus so normalizeHomeRunRecord can fall back to row.
					metadata: {
						childRunStatus: "completed",
						childRunPreview: `Result ${i}`,
					},
				}),
			);
			// Add live child events — these should not be queried for terminal runs.
			db.runtimeEvents.push(
				childRuntimeEvent({
					createdAt: `2026-06-06T08:${String(i).padStart(2, "0")}:00.000Z`,
					id: `child-event-${i}`,
					kind: "run.completed",
					payload: { status: "completed", content: `Result ${i}` },
					runId: childRunId,
					tediId: "tedi-echo",
				}),
			);
			// The async-completion message is already durable (the terminal
			// reconcile wrote it when the run settled) — the deterministic event id
			// is what the read-repair existence gate checks.
			db.events.push(
				normalizeKernelRuntimeEventInsert({
					id: [
						"home",
						ORG_ID,
						"event",
						"message.completed",
						"home:heavy",
						runId,
						"delegation-completion",
					].join(":"),
					organizationId: ORG_ID,
					kind: "message.completed",
					conversationId: "home:heavy",
					runId,
					messageId: `${runId}:async-completion:assistant`,
					delegatedTediId: "tedi-echo",
					childRunId,
					payload: { role: "assistant", content: `Result ${i}` },
					createdAt: `2026-06-06T08:${String(i).padStart(2, "0")}:00.000Z`,
				}),
			);
		}

		const client = createKernelRuntimeClient(createContext(db));
		const result = await client.readRunSet({
			conversationId: "home:heavy",
			limit: TERMINAL_COUNT,
		});

		// All runs returned, all terminal.
		expect(result.runSet.runs).toHaveLength(TERMINAL_COUNT);
		expect(result.runSet.activeRunIds).toEqual([]);
		// No live child-evidence queries were issued.
		expect(childEvidenceSelectCount).toBe(0);
		// Runs use persisted row data for child fields.
		for (const run of result.runSet.runs) {
			expect(run.status).toBe("completed");
			expect(run.metadata?.childRunStatus).toBe("completed");
		}
	});

	it("repairs a missing completion message with the child's real final answer", async () => {
		// Already-terminal row whose async-completion message is missing (a prior
		// fail-soft insert failure). The read repair must pay the real content
		// path: the child's final assistant message, not the rolling preview.
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		const childRunId = "tedi-echo:mcp:home-repair-content-1_delegate_tedi-echo";
		const completedAt = "2026-06-24T09:10:00.000Z";
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-repair-content-1",
				organizationId: ORG_ID,
				conversationId: "home:repair-content",
				status: "completed",
				inputMessageId: "home-repair-content-1:input",
				outputMessageId: "home-repair-content-1:async-completion:assistant",
				delegatedTediId: "tedi-echo",
				childRunId,
				childConversationId: "agent:main:main",
				latestEventKind: "run.completed",
				latestEventAt: completedAt,
				preview: "Rolling activity preview.",
				metadata: { delegatedTediId: "tedi-echo" },
				completedAt,
				createdAt: "2026-06-24T09:00:00.000Z",
				updatedAt: completedAt,
			}),
		);
		db.runtimeEvents.push(
			childRuntimeEvent({
				id: "evt-repair-content-message",
				kind: "message.completed",
				runId: childRunId,
				tediId: "tedi-echo",
				createdAt: completedAt,
				payload: {
					role: "assistant",
					content: "Here is the full audit result: 3 findings, all fixed.",
				},
			}),
			childRuntimeEvent({
				id: "evt-repair-content-completed",
				kind: "run.completed",
				runId: childRunId,
				tediId: "tedi-echo",
				createdAt: completedAt,
				payload: { status: "completed" },
			}),
		);

		await client.readRunSet({
			conversationId: "home:repair-content",
			limit: 10,
		});

		const completionMessages = db.events.filter(
			(event) =>
				event.messageId === "home-repair-content-1:async-completion:assistant",
		);
		expect(completionMessages).toHaveLength(1);
		expect(completionMessages[0]?.payload).toMatchObject({
			role: "assistant",
			content: "Here is the full audit result: 3 findings, all fixed.",
		});

		// Idempotent: a second read finds the message via the deterministic-id
		// gate and neither duplicates it nor re-reads child evidence.
		let childEvidenceSelectCount = 0;
		const originalSelect = db.select.bind(db);
		db.select = (() => {
			const builder = originalSelect();
			const originalFrom = builder.from.bind(builder);
			builder.from = (table: unknown) => {
				if (isRuntimeEventSource(table)) childEvidenceSelectCount += 1;
				return originalFrom(table);
			};
			return builder;
		}) as typeof db.select;
		await client.readRunSet({
			conversationId: "home:repair-content",
			limit: 10,
		});
		expect(
			db.events.filter(
				(event) =>
					event.messageId ===
					"home-repair-content-1:async-completion:assistant",
			),
		).toHaveLength(1);
		expect(childEvidenceSelectCount).toBe(0);
	});

	it("keeps the run set readable when a historical delegation Work Item is missing", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		const runId = "terminal-repair-failure";
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: runId,
				organizationId: ORG_ID,
				conversationId: "home:repair-failure",
				status: "completed",
				delegatedTediId: "tedi-echo",
				childRunId: "tedi-echo:mcp:terminal-repair-failure",
				preview: "Completed child result",
				metadata: {
					childRunStatus: "completed",
					workItemId: "missing-work-item",
				},
				completedAt: "2026-06-24T10:00:00.000Z",
				createdAt: "2026-06-24T09:00:00.000Z",
				updatedAt: "2026-06-24T10:00:00.000Z",
			}),
		);

		const result = await client.readRunSet({
			conversationId: "home:repair-failure",
			limit: 10,
		});

		expect(result.runSet.runs.map((run) => run.id)).toContain(runId);
	});

	it("repair falls back to the preview content when the child read keeps failing", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		const childRunId =
			"tedi-echo:mcp:home-repair-fallback-1_delegate_tedi-echo";
		const completedAt = "2026-06-24T10:10:00.000Z";
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-repair-fallback-1",
				organizationId: ORG_ID,
				conversationId: "home:repair-fallback",
				status: "completed",
				inputMessageId: "home-repair-fallback-1:input",
				outputMessageId: "home-repair-fallback-1:async-completion:assistant",
				delegatedTediId: "tedi-echo",
				childRunId,
				childConversationId: "agent:main:main",
				latestEventKind: "run.completed",
				latestEventAt: completedAt,
				preview: "Child result preview.",
				metadata: { delegatedTediId: "tedi-echo" },
				completedAt,
				createdAt: "2026-06-24T10:00:00.000Z",
				updatedAt: completedAt,
			}),
		);
		// Child evidence reads fail persistently (transport flake beyond the
		// bounded in-request retries) — the repair must fall back to the
		// preview-based content instead of failing the reconcile.
		db.controls.childRuntimeSelectError = new Error(
			"D1_ERROR: Failed to parse body as JSON, got: Error: Network connection lost.",
		);

		const result = await client.readRunSet({
			conversationId: "home:repair-fallback",
			limit: 10,
		});

		expect(result.runSet.runs[0]).toMatchObject({
			id: "home-repair-fallback-1",
			status: "completed",
		});
		const completionMessages = db.events.filter(
			(event) =>
				event.messageId === "home-repair-fallback-1:async-completion:assistant",
		);
		expect(completionMessages).toHaveLength(1);
		expect(completionMessages[0]?.payload).toMatchObject({
			role: "assistant",
			content:
				"The delegated tedi finished the assignment. Latest evidence: Child result preview.",
		});
	});

	it("keeps concurrent delegated CPO and Echo runs separated in one Home conversation", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		kernelRuntimeTestHooks.setDelegateRunnerForTest(async (input) => ({
			childConversationId: "agent:main:main",
			childRunId: input.childRunId,
			status: "queued",
		}));

		await client.enqueueMessage({
			conversationId: "home:test",
			content: "Ask CPO for a launch checklist",
			delegateToTediId: "tedi-cpo",
			idempotencyKey: "home-multi-cpo",
		});
		await client.enqueueMessage({
			conversationId: "home:test",
			content: "Ask Echo for a data check",
			delegateToTediId: "tedi-echo",
			idempotencyKey: "home-multi-echo",
		});
		const cpoFinal =
			"Launch checklist: confirm ownership, schedule rollout, and monitor adoption.";
		const echoFinal =
			"Data check: all requested records match the source totals.";
		db.runtimeEvents.push(
			childRuntimeEvent({
				createdAt: "2026-06-06T08:01:59.000Z",
				id: "runtime-multi-cpo-final",
				kind: "message.completed",
				messageId: "cpo-launch-final",
				payload: { role: "assistant", content: cpoFinal },
				runId: "tedi-cpo:mcp:home-multi-cpo_delegate_tedi-cpo",
				tediId: "tedi-cpo",
			}),
			childRuntimeEvent({
				createdAt: "2026-06-06T08:02:59.000Z",
				id: "runtime-multi-echo-final",
				kind: "message.completed",
				messageId: "echo-data-final",
				payload: { role: "assistant", content: echoFinal },
				runId: "tedi-echo:mcp:home-multi-echo_delegate_tedi-echo",
				tediId: "tedi-echo",
			}),
			childRuntimeEvent({
				createdAt: "2026-06-06T08:02:00.000Z",
				id: "runtime-multi-cpo-completed",
				kind: "run.completed",
				payload: {
					status: "completed",
					content: "CPO launch checklist proof.",
				},
				runId: "tedi-cpo:mcp:home-multi-cpo_delegate_tedi-cpo",
				tediId: "tedi-cpo",
			}),
			childRuntimeEvent({
				createdAt: "2026-06-06T08:03:00.000Z",
				id: "runtime-multi-echo-completed",
				kind: "run.completed",
				payload: {
					status: "completed",
					content: "Echo data check proof.",
				},
				runId: "tedi-echo:mcp:home-multi-echo_delegate_tedi-echo",
				tediId: "tedi-echo",
			}),
		);

		const result = await client.readRunSet({
			conversationId: "home:test",
			limit: 10,
		});
		const runsById = new Map(result.runSet.runs.map((run) => [run.id, run]));

		expect(result.runSet.activeRunIds).toEqual([]);
		expect(runsById.get("home-multi-cpo")).toMatchObject({
			status: "completed",
			delegatedTediId: "tedi-cpo",
			childRunId: "tedi-cpo:mcp:home-multi-cpo_delegate_tedi-cpo",
			metadata: {
				childRunPreview: cpoFinal,
			},
		});
		expect(runsById.get("home-multi-echo")).toMatchObject({
			status: "completed",
			delegatedTediId: "tedi-echo",
			childRunId: "tedi-echo:mcp:home-multi-echo_delegate_tedi-echo",
			metadata: {
				childRunPreview: echoFinal,
			},
		});

		const completionMessages = db.events
			.filter((event) =>
				event.messageId?.includes(":async-completion:assistant"),
			)
			.map((event) => ({
				childRunId: event.childRunId,
				content: (event.payload as { content?: string } | null)?.content,
				delegatedTediId: event.delegatedTediId,
				messageId: event.messageId,
			}));

		expect(completionMessages).toHaveLength(2);
		expect(completionMessages).toEqual(
			expect.arrayContaining([
				{
					childRunId: "tedi-cpo:mcp:home-multi-cpo_delegate_tedi-cpo",
					content: cpoFinal,
					delegatedTediId: "tedi-cpo",
					messageId: "home-multi-cpo:async-completion:assistant",
				},
				{
					childRunId: "tedi-echo:mcp:home-multi-echo_delegate_tedi-echo",
					content: echoFinal,
					delegatedTediId: "tedi-echo",
					messageId: "home-multi-echo:async-completion:assistant",
				},
			]),
		);

		const messages = await client.readMessages({
			conversationId: "home:test",
			limit: 10,
		});
		const renderedCompletions = messages.messages
			.filter((message) => message.id.endsWith(":async-completion:assistant"))
			.map((message) => ({
				childRunId: message.childRunId,
				content: message.content,
				delegatedTediId: message.delegatedTediId,
				messageId: message.id,
			}));
		expect(renderedCompletions).toHaveLength(2);
		expect(renderedCompletions).toEqual(
			expect.arrayContaining(completionMessages),
		);
	});

	it("reads delegated child run evidence from the runtime owner ledger", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		db.runtimeEvents.push(
			{
				artifactId: null,
				approvalRequestId: null,
				conversationId: "agent:main:main",
				createdAt: "2026-06-06T08:00:00.000Z",
				delta: null,
				id: "runtime-child-started",
				kind: "run.started",
				messageId: null,
				organizationId: ORG_ID,
				payload: { status: "running" },
				runId: "child-run-evidence",
				runtimeBackend: "cloudflare-agents",
				runtimeExternalId: null,
				runtimeExternalUrl: null,
				runtimeMetadata: null,
				sequence: null,
				tediId: "tedi-cpo",
				toolCallId: null,
			},
			{
				artifactId: "artifact-1",
				approvalRequestId: null,
				conversationId: "agent:main:main",
				createdAt: "2026-06-06T08:01:00.000Z",
				delta: null,
				id: "runtime-child-artifact",
				kind: "artifact.created",
				messageId: null,
				organizationId: ORG_ID,
				payload: { text: "Evidence bundle ready" },
				runId: "child-run-evidence",
				runtimeBackend: "cloudflare-agents",
				runtimeExternalId: null,
				runtimeExternalUrl: null,
				runtimeMetadata: null,
				sequence: null,
				tediId: "tedi-cpo",
				toolCallId: null,
			},
			{
				artifactId: null,
				approvalRequestId: null,
				conversationId: "agent:main:main",
				createdAt: "2026-06-06T08:02:00.000Z",
				delta: null,
				id: "runtime-child-completed",
				kind: "run.completed",
				messageId: null,
				organizationId: ORG_ID,
				payload: { status: "completed" },
				runId: "child-run-evidence",
				runtimeBackend: "cloudflare-agents",
				runtimeExternalId: null,
				runtimeExternalUrl: null,
				runtimeMetadata: null,
				sequence: null,
				tediId: "tedi-cpo",
				toolCallId: null,
			},
		);
		db.artifacts.push({
			accessClassification: "runtime_private",
			conversationId: "agent:main:main",
			createdAt: "2026-06-06T08:01:00.000Z",
			id: "artifact-1",
			kind: "document",
			messageId: null,
			metadata: { source: "test" },
			mimeType: "text/markdown",
			name: "Evidence bundle",
			organizationId: ORG_ID,
			runId: "child-run-evidence",
			sizeBytes: 2048,
			tediId: "tedi-cpo",
			uri: "r2://tedix/evidence.md",
		});
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-parent-with-work-item",
				organizationId: ORG_ID,
				conversationId: "home:test",
				status: "running",
				delegatedTediId: "tedi-cpo",
				childRunId: "child-run-evidence",
				metadata: {
					workItemId: "wi-child-evidence",
				},
			}),
		);

		const result = await client.readChildRunEvidence({
			childRunId: "child-run-evidence",
			delegatedTediId: "tedi-cpo",
		});

		expect(result.evidence).toMatchObject({
			childRunId: "child-run-evidence",
			delegatedTediId: "tedi-cpo",
			workItemId: "wi-child-evidence",
			status: "completed",
			latestEventKind: "run.completed",
			terminalAt: "2026-06-06T08:02:00.000Z",
			terminalEventKind: "run.completed",
			control: {
				canStop: false,
				state: "terminal",
			},
		});
		expect(result.evidence.events.map((event) => event.id)).toEqual([
			"runtime-child-completed",
			"runtime-child-artifact",
			"runtime-child-started",
		]);
		expect(result.evidence.artifacts.map((artifact) => artifact.id)).toEqual([
			"artifact-1",
		]);
		expect(result.evidence.artifacts[0]?.uri).toBeUndefined();
		expect(result.evidence.artifacts[0]?.metadata).toBeUndefined();
	});

	it("does not expose child run evidence for a tedi outside the organization", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		db.tediRows.push({
			id: "tedi-outside",
			organizationId: "org-outside",
			runtimeKind: "agent",
		});

		await expect(
			client.readChildRunEvidence({
				childRunId: "outside-run",
				delegatedTediId: "tedi-outside",
			}),
		).rejects.toThrow("Delegated tedi not found");
	});

	it("returns workstation process log artifact rows as child run evidence", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		db.artifacts.push(
			{
				conversationId: "cto:agent:main:main",
				createdAt: "2026-06-06T08:03:00.000Z",
				id: "child-run-workstation:artifact:workstation_process:install-deps:evidence",
				kind: "log",
				messageId: null,
				metadata: {
					source: "workstation_process",
					subKind: "workstation_process",
					processId: "install-deps",
					refType: "evidence",
					traceId: "trace-workstation-1",
				},
				mimeType: "application/json",
				name: "workstation_process/install-deps/evidence.json",
				organizationId: ORG_ID,
				runId: "child-run-workstation",
				sizeBytes: null,
				tediId: "tedi-cto",
				uri: "r2://tedix-tedi-production/orgs/org-1/tedis/cto/workstations/general/processes/install-deps/terminal/evidence.json",
			},
			{
				conversationId: "cto:agent:main:main",
				createdAt: "2026-06-06T08:02:00.000Z",
				id: "child-run-workstation:artifact:workstation_process:install-deps:stdout",
				kind: "log",
				messageId: null,
				metadata: {
					source: "workstation_process",
					subKind: "workstation_process",
					processId: "install-deps",
					refType: "stdout",
					traceId: "trace-workstation-1",
				},
				mimeType: "text/plain; charset=utf-8",
				name: "workstation_process/install-deps/stdout.log",
				organizationId: ORG_ID,
				runId: "child-run-workstation",
				sizeBytes: null,
				tediId: "tedi-cto",
				uri: "r2://tedix-tedi-production/orgs/org-1/tedis/cto/workstations/general/processes/install-deps/terminal/stdout.log",
			},
		);

		const result = await client.readChildRunEvidence({
			childRunId: "child-run-workstation",
			delegatedTediId: "tedi-cto",
		});

		expect(result.evidence.artifacts.map((artifact) => artifact.id)).toEqual([
			"child-run-workstation:artifact:workstation_process:install-deps:evidence",
			"child-run-workstation:artifact:workstation_process:install-deps:stdout",
		]);
		expect(result.evidence.artifacts[0]).toMatchObject({
			kind: "log",
			name: "workstation_process/install-deps/evidence.json",
			metadata: {
				source: "workstation_process",
				processId: "install-deps",
				refType: "evidence",
			},
		});
	});

	it("keeps child run evidence readable when runtime event reads flake", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		db.controls.childRuntimeSelectError = new Error(
			"D1_ERROR: Failed to parse body as JSON, got: Error: Network connection lost.",
		);
		db.artifacts.push({
			conversationId: "agent:main:main",
			createdAt: "2026-06-06T08:01:00.000Z",
			id: "artifact-flaky-events",
			kind: "document",
			messageId: null,
			metadata: { source: "test" },
			mimeType: "text/markdown",
			name: "Evidence bundle",
			organizationId: ORG_ID,
			runId: "child-run-flaky-events",
			sizeBytes: 2048,
			tediId: "tedi-cpo",
			uri: "r2://tedix/evidence.md",
		});

		const result = await client.readChildRunEvidence({
			childRunId: "child-run-flaky-events",
			delegatedTediId: "tedi-cpo",
		});

		expect(result.evidence).toMatchObject({
			childRunId: "child-run-flaky-events",
			delegatedTediId: "tedi-cpo",
			status: "queued",
			latestEventAt: null,
		});
		expect(result.evidence.events).toEqual([]);
		expect(result.evidence.artifacts.map((artifact) => artifact.id)).toEqual([
			"artifact-flaky-events",
		]);
	});

	it("keeps child run evidence readable when artifact reads flake", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		db.controls.artifactSelectError = new Error(
			"D1_ERROR: Failed to parse body as JSON, got: Error: Network connection lost.",
		);
		// Genuine completion: include message.completed so the disposition gate
		// reports completed even when artifact reads flake.
		db.runtimeEvents.push(
			childRuntimeEvent({
				createdAt: "2026-06-06T08:01:00.000Z",
				id: "runtime-flaky-artifacts-message",
				kind: "message.completed",
				payload: { role: "assistant", content: "Artifact run complete." },
				runId: "child-run-flaky-artifacts",
				tediId: "tedi-cpo",
			}),
			childRuntimeEvent({
				createdAt: "2026-06-06T08:02:00.000Z",
				id: "runtime-flaky-artifacts-completed",
				kind: "run.completed",
				payload: { status: "completed" },
				runId: "child-run-flaky-artifacts",
				tediId: "tedi-cpo",
			}),
		);

		const result = await client.readChildRunEvidence({
			childRunId: "child-run-flaky-artifacts",
			delegatedTediId: "tedi-cpo",
		});

		expect(result.evidence).toMatchObject({
			childRunId: "child-run-flaky-artifacts",
			delegatedTediId: "tedi-cpo",
			status: "completed",
			latestEventKind: "run.completed",
		});
		expect(result.evidence.events.map((event) => event.id)).toEqual([
			"runtime-flaky-artifacts-completed",
			"runtime-flaky-artifacts-message",
		]);
		expect(result.evidence.artifacts).toEqual([]);
	});

	it("surfaces workstation.egress.deny events stored under kernel run id as child run evidence", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		// The kernel delegation row: id is the kernel run id; childRunId is the
		// tedi-runtime run id. Egress events carry runId = kernelRunId (id), not
		// childRunId — that is the gap this fix addresses.
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "kernel-run-egress",
				organizationId: ORG_ID,
				conversationId: "home:test",
				status: "running",
				delegatedTediId: "tedi-cpo",
				childRunId: "child-run-egress",
			}),
		);
		// Egress event recorded by tedi-workstation-runtime with runId = kernel run id.
		db.runtimeEvents.push({
			artifactId: null,
			approvalRequestId: null,
			conversationId: "agent:main:main",
			createdAt: "2026-06-06T08:01:00.000Z",
			delta: null,
			id: "egress-deny-1",
			kind: "workstation.egress.deny",
			messageId: null,
			organizationId: ORG_ID,
			payload: {
				decision: "deny",
				host: "blocked.example.com",
				method: "GET",
				protocol: "https",
				reason: "not_in_allowlist",
				kernelRunId: "kernel-run-egress",
				workstationId: "ws-1",
				adapter: "cloudflare-sandbox-workstation",
				leaseId: null,
				profileId: null,
				traceBundleId: null,
				traceId: null,
				workItemId: null,
				containerId: "ws-1",
				className: "WorkstationDO",
				loggingMode: "all",
			},
			runId: "kernel-run-egress",
			runtimeBackend: "custom",
			runtimeExternalId: "ws-1",
			runtimeExternalUrl: null,
			runtimeMetadata: {
				adapter: "cloudflare-sandbox-workstation",
				kernelRunId: "kernel-run-egress",
				workstationId: "ws-1",
			},
			sequence: null,
			tediId: "tedi-cpo",
			toolCallId: null,
		});

		const result = await client.readChildRunEvidence({
			childRunId: "child-run-egress",
			delegatedTediId: "tedi-cpo",
		});

		expect(result.evidence.events.map((event) => event.id)).toContain(
			"egress-deny-1",
		);
		const egressEvent = result.evidence.events.find(
			(event) => event.id === "egress-deny-1",
		);
		expect(egressEvent).toMatchObject({
			id: "egress-deny-1",
			kind: "workstation.egress.deny",
			payload: {
				decision: "deny",
				host: "blocked.example.com",
				reason: "not_in_allowlist",
			},
		});
	});

	it("keeps Home messages readable when child runtime status enrichment fails", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		db.controls.childRuntimeSelectError = new Error(
			"D1_ERROR: Failed to parse body as JSON, got: Error: Network connection lost.",
		);
		db.events.push(
			normalizeKernelRuntimeEventInsert({
				id: "assistant-delegated",
				organizationId: ORG_ID,
				kind: "message.completed",
				conversationId: "home:test",
				messageId: "assistant-delegated",
				runId: "home-run",
				delegatedTediId: "tedi-cpo",
				childRunId: "child-run-flaky",
				payload: {
					content: "I delegated this Home turn.",
					metadata: {
						childRunId: "child-run-flaky",
						delegatedTediId: "tedi-cpo",
					},
					role: "assistant",
				},
				createdAt: "2026-06-06T08:00:00.000Z",
			}),
		);

		const messages = await client.readMessages({
			conversationId: "home:test",
			limit: 10,
		});

		expect(messages.messages).toHaveLength(1);
		expect(messages.messages[0]).toMatchObject({
			content: "I delegated this Home turn.",
			role: "assistant",
			status: "completed",
		});
		const flakyMessageMetadata = messages.messages[0]?.metadata?.metadata as
			| Record<string, unknown>
			| undefined;
		expect(flakyMessageMetadata).toMatchObject({
			childRunId: "child-run-flaky",
			delegatedTediId: "tedi-cpo",
		});
		expect(flakyMessageMetadata?.childRunStatus).toBeUndefined();
	});

	// The parent cancellation and child execution are independent facts. Cached
	// child activity must not revive the Home outcome or its message progress.
	it.each([undefined, "running"] as const)(
		"keeps a canceled Home turn canceled when its child finishes late (cached %s)",
		async (cachedChildStatus) => {
			const db = createKernelRuntimeDb();
			const client = createKernelRuntimeClient(createContext(db));
			const canceledPreview =
				"Home run canceled by operator: Stopped from Home composer";
			db.runs.push(
				normalizeKernelRuntimeRunInsert({
					id: "home-run-canceled-late-child",
					organizationId: ORG_ID,
					conversationId: "home:test",
					status: "canceled",
					metadata: {
						childRunStatus: cachedChildStatus,
						childRunPreview: "child still working",
						childRunLatestEventAt: "2026-06-06T08:00:30.000Z",
					},
					delegatedTediId: "tedi-cpo",
					childRunId: "child-run-late",
					childConversationId: "agent:main:main",
					preview: canceledPreview,
					createdAt: "2026-06-06T08:00:00.000Z",
					completedAt: "2026-06-06T08:01:00.000Z",
					updatedAt: "2026-06-06T08:01:00.000Z",
				}),
			);
			db.events.push(
				normalizeKernelRuntimeEventInsert({
					id: "assistant-ack-late-child",
					organizationId: ORG_ID,
					kind: "message.completed",
					conversationId: "home:test",
					messageId: "assistant-ack-late-child",
					runId: "home-run-canceled-late-child",
					delegatedTediId: "tedi-cpo",
					childRunId: "child-run-late",
					payload: {
						content: "On it — delegating to CPO now.",
						metadata: {
							childRunId: "child-run-late",
							delegatedTediId: "tedi-cpo",
						},
						role: "assistant",
					},
					createdAt: "2026-06-06T08:00:30.000Z",
				}),
				normalizeKernelRuntimeEventInsert({
					id: "assistant-completion-late-child",
					organizationId: ORG_ID,
					kind: "message.completed",
					conversationId: "home:test",
					messageId: "home-run-canceled-late-child:async-completion:assistant",
					runId: "home-run-canceled-late-child",
					delegatedTediId: "tedi-cpo",
					childRunId: "child-run-late",
					payload: {
						content: `The delegated tedi assignment was canceled. Latest evidence: ${canceledPreview}`,
						metadata: {
							asyncCompletion: true,
							childRunId: "child-run-late",
							delegatedTediId: "tedi-cpo",
						},
						role: "assistant",
					},
					createdAt: "2026-06-06T08:01:00.000Z",
				}),
			);
			// The child kept running past the parent cancel and published its own
			// terminal `run.completed` afterwards.
			db.runtimeEvents.push({
				artifactId: null,
				approvalRequestId: null,
				conversationId: "agent:main:main",
				createdAt: "2026-06-06T08:02:00.000Z",
				delta: "Awaiting your request.",
				id: "runtime-child-completed-late",
				kind: "run.completed",
				messageId: null,
				organizationId: ORG_ID,
				payload: { status: "completed", content: "Awaiting your request." },
				runId: "child-run-late",
				runtimeBackend: "cloudflare-agents",
				runtimeExternalId: null,
				runtimeExternalUrl: null,
				runtimeMetadata: null,
				sequence: null,
				tediId: "tedi-cpo",
				toolCallId: null,
			});

			const messages = await client.readMessages({
				conversationId: "home:test",
				limit: 10,
			});

			const ack = messages.messages.find(
				(message) => message.id === "assistant-ack-late-child",
			);
			const ackMetadata = ack?.metadata?.metadata as
				| Record<string, unknown>
				| undefined;
			expect(ackMetadata?.childRunStatus).toBe(cachedChildStatus ?? "canceled");
			expect(ackMetadata?.delegationStatus).toBe("canceled");
			expect(ackMetadata?.childRunPreview).toBe(canceledPreview);
			expect(ackMetadata?.progress).toMatchObject({
				current: 100,
				label: "Stopped",
			});
			expect(ack?.status).toBe("completed");

			// The completion prose and delegation outcome agree on cancellation.
			const completion = messages.messages.find(
				(message) =>
					message.id ===
					"home-run-canceled-late-child:async-completion:assistant",
			);
			expect(completion?.content).toContain(
				"The delegated tedi assignment was canceled.",
			);
			const completionMetadata = completion?.metadata?.metadata as
				| Record<string, unknown>
				| undefined;
			expect(completionMetadata?.childRunStatus).toBe(
				cachedChildStatus ?? "canceled",
			);
			expect(completionMetadata?.delegationStatus).toBe("canceled");
			expect(completionMetadata?.progress).toMatchObject({
				current: 100,
				label: "Stopped",
			});
			const reread = await client.readMessages({
				conversationId: "home:test",
				limit: 10,
			});
			expect(reread.messages).toEqual(messages.messages);
		},
	);

	it("skips a contradictory completed child when reading a terminal Home parent directly", async () => {
		const db = createKernelRuntimeDb();
		const parent = normalizeKernelRuntimeRunInsert({
			id: "home-run-direct-terminal-guard",
			organizationId: ORG_ID,
			conversationId: "home:test",
			status: "canceled",
			delegatedTediId: "tedi-cpo",
			childRunId: "child-direct-terminal-guard",
			createdAt: "2026-06-06T08:00:00.000Z",
			completedAt: "2026-06-06T08:01:00.000Z",
			updatedAt: "2026-06-06T08:01:00.000Z",
		});
		const message = normalizeKernelRuntimeEventInsert({
			id: "direct-terminal-guard-message",
			organizationId: ORG_ID,
			kind: "message.completed",
			conversationId: "home:test",
			runId: parent.id,
			delegatedTediId: "tedi-cpo",
			childRunId: "child-direct-terminal-guard",
			createdAt: "2026-06-06T08:00:30.000Z",
		});
		db.runtimeEvents.push({
			artifactId: null,
			approvalRequestId: null,
			conversationId: "agent:main:main",
			createdAt: "2026-06-06T08:02:00.000Z",
			delta: "Child finished after parent cancellation",
			id: "direct-terminal-guard-child-completed",
			kind: "run.completed",
			messageId: null,
			organizationId: ORG_ID,
			payload: {
				status: "completed",
				content: "Child finished after parent cancellation",
			},
			runId: "child-direct-terminal-guard",
			runtimeBackend: "cloudflare-agents",
			runtimeExternalId: null,
			runtimeExternalUrl: null,
			runtimeMetadata: null,
			sequence: null,
			tediId: "tedi-cpo",
			toolCallId: null,
		});

		const context = createContext(db);
		const canceledRun = normalizeHomeRunRecord(parent);
		const canceledStatuses = await readChildRunStatuses(
			context,
			[message],
			new Map([[parent.id, canceledRun]]),
		);
		expect(canceledStatuses.size).toBe(0);

		const runningRun = normalizeHomeRunRecord({
			...parent,
			status: "running",
			completedAt: null,
		});
		const runningStatuses = await readChildRunStatuses(
			context,
			[message],
			new Map([[parent.id, runningRun]]),
		);
		expect(
			runningStatuses.get("tedi-cpo:child-direct-terminal-guard"),
		).toMatchObject({
			childRunStatus: "completed",
		});
	});

	// One delegation = one row. The delegation lifecycle used to emit up to four
	// full-height assistant turns per delegation, each restating what the 40px
	// receipt row beside them already renders (target, humanized status, clamped
	// preview). The ledger keeps every row; the rendered transcript keeps one.
	it("collapses delegation lifecycle narration to the single receipt row", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-run-collapse",
				organizationId: ORG_ID,
				conversationId: "home:test",
				status: "canceled",
				delegatedTediId: "tedi-cpo",
				childRunId: "child-collapse",
				childConversationId: "agent:main:main",
				preview: "Home run canceled by operator",
				createdAt: "2026-06-06T08:00:00.000Z",
				completedAt: "2026-06-06T08:01:00.000Z",
				updatedAt: "2026-06-06T08:01:00.000Z",
			}),
		);
		db.events.push(
			normalizeKernelRuntimeEventInsert({
				id: "collapse-ack",
				organizationId: ORG_ID,
				kind: "message.completed",
				conversationId: "home:test",
				messageId: "home-run-collapse:assistant",
				runId: "home-run-collapse",
				delegatedTediId: "tedi-cpo",
				childRunId: "child-collapse",
				payload: {
					role: "assistant",
					content:
						"On it — delegating to CPO now. I'll bring CPO's result back here when it's done.",
					metadata: {
						childRunId: "child-collapse",
						delegatedTediId: "tedi-cpo",
						homeNarration: "delegation_ack",
					},
				},
				createdAt: "2026-06-06T08:00:30.000Z",
			}),
			normalizeKernelRuntimeEventInsert({
				id: "collapse-completion",
				organizationId: ORG_ID,
				kind: "message.completed",
				conversationId: "home:test",
				messageId: "home-run-collapse:async-completion:assistant",
				runId: "home-run-collapse",
				delegatedTediId: "tedi-cpo",
				childRunId: "child-collapse",
				payload: {
					role: "assistant",
					content:
						"The delegated tedi assignment was canceled. Latest evidence: Home run canceled by operator",
					metadata: {
						asyncCompletion: true,
						childRunId: "child-collapse",
						delegatedTediId: "tedi-cpo",
						homeNarration: "delegation_status_only",
					},
				},
				createdAt: "2026-06-06T08:01:00.000Z",
			}),
		);

		const messages = await client.readMessages({
			conversationId: "home:test",
			limit: 10,
		});

		// The terminal restatement is gone from the rendered transcript — the ack
		// row ahead of it already owns the receipt for this child run.
		expect(
			messages.messages.some(
				(message) =>
					message.id === "home-run-collapse:async-completion:assistant",
			),
		).toBe(false);
		// The ack row survives (it is the only carrier of the delegation metadata
		// Tedix OS builds the receipt from) but renders no prose.
		const ack = messages.messages.find(
			(message) => message.id === "home-run-collapse:assistant",
		);
		expect(ack).toBeDefined();
		expect(ack?.content).toBe("");
		const ackMetadata = ack?.metadata?.metadata as
			| Record<string, unknown>
			| undefined;
		expect(ackMetadata?.delegatedTediId).toBe("tedi-cpo");
		expect(ackMetadata?.childRunId).toBe("child-collapse");
	});

	it("keeps a delegation completion that relays a real child answer", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		db.events.push(
			normalizeKernelRuntimeEventInsert({
				id: "relay-ack",
				organizationId: ORG_ID,
				kind: "message.completed",
				conversationId: "home:test",
				messageId: "home-run-relay:assistant",
				runId: "home-run-relay",
				delegatedTediId: "tedi-cpo",
				childRunId: "child-relay",
				payload: {
					role: "assistant",
					content: "On it — delegating to CPO now.",
					metadata: {
						childRunId: "child-relay",
						delegatedTediId: "tedi-cpo",
						homeNarration: "delegation_ack",
					},
				},
				createdAt: "2026-06-06T08:00:30.000Z",
			}),
			normalizeKernelRuntimeEventInsert({
				id: "relay-completion",
				organizationId: ORG_ID,
				kind: "message.completed",
				conversationId: "home:test",
				messageId: "home-run-relay:async-completion:assistant",
				runId: "home-run-relay",
				delegatedTediId: "tedi-cpo",
				childRunId: "child-relay",
				// Unstamped: the child returned a final assistant message, so this
				// turn carries the delegation's actual return value.
				payload: {
					role: "assistant",
					content:
						"Outcome: succeeded\n\nThe migration shipped as repo_commit …",
					metadata: {
						asyncCompletion: true,
						childRunId: "child-relay",
						delegatedTediId: "tedi-cpo",
					},
				},
				createdAt: "2026-06-06T08:01:00.000Z",
			}),
		);

		const messages = await client.readMessages({
			conversationId: "home:test",
			limit: 10,
		});

		const completion = messages.messages.find(
			(message) => message.id === "home-run-relay:async-completion:assistant",
		);
		expect(completion?.content).toContain("Outcome: succeeded");
	});

	it("hides kernel-internal inbox-wake prompts from the Home transcript", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		db.events.push(
			normalizeKernelRuntimeEventInsert({
				id: "wake-input",
				organizationId: ORG_ID,
				kind: "message.received",
				conversationId: "home:test",
				messageId: "wake-run:input",
				runId: "wake-run",
				payload: {
					role: "user",
					content:
						"[System: 1 delegated task completed — summarize the results for the operator in this thread]",
					channel: "home",
					metadata: {
						dispatchMode: "kernel-inbox-wake",
						kernelInboxRunIds: ["child-1"],
					},
				},
				createdAt: "2026-06-06T08:00:00.000Z",
			}),
			normalizeKernelRuntimeEventInsert({
				id: "operator-input",
				organizationId: ORG_ID,
				kind: "message.received",
				conversationId: "home:test",
				messageId: "op-run:input",
				runId: "op-run",
				payload: {
					role: "user",
					content: "what workflows do we have?",
					channel: "home",
					metadata: {},
				},
				createdAt: "2026-06-06T08:01:00.000Z",
			}),
		);

		const messages = await client.readMessages({
			conversationId: "home:test",
			limit: 10,
		});

		// The synthetic wake prompt is kernel machinery — an operator-visible
		// user message that may never get a reply reads as a hang. Only the real
		// operator turn surfaces.
		expect(messages.messages).toHaveLength(1);
		expect(messages.messages[0]).toMatchObject({
			content: "what workflows do we have?",
			role: "user",
		});
	});

	it("keeps Home reads usable when the shared D1 history query flakes", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		db.controls.kernelRuntimeSelectError = new Error(
			"D1_ERROR: Failed to parse body as JSON, got: Error: Network connection lost.",
		);

		const conversations = await client.listConversations({ limit: 10 });
		const messages = await client.readMessages({
			conversationId: "home:test",
			limit: 10,
		});

		expect(conversations).toEqual({ conversations: [], nextCursor: null });
		expect(messages).toEqual({ messages: [], nextCursor: null });
	});

	it("paginates Home messages by message rows when run events are interleaved", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		db.events.push(
			normalizeKernelRuntimeEventInsert({
				id: "run-newer",
				organizationId: ORG_ID,
				kind: "run.completed",
				conversationId: "home:test",
				runId: "run-newer",
				createdAt: "2026-06-06T08:05:00.000Z",
			}),
			normalizeKernelRuntimeEventInsert({
				id: "message-newer",
				organizationId: ORG_ID,
				kind: "message.completed",
				conversationId: "home:test",
				messageId: "message-newer",
				runId: "run-message-newer",
				payload: { role: "assistant", content: "newer message" },
				createdAt: "2026-06-06T08:04:00.000Z",
			}),
			normalizeKernelRuntimeEventInsert({
				id: "run-middle",
				organizationId: ORG_ID,
				kind: "run.completed",
				conversationId: "home:test",
				runId: "run-middle",
				createdAt: "2026-06-06T08:03:00.000Z",
			}),
			normalizeKernelRuntimeEventInsert({
				id: "message-older",
				organizationId: ORG_ID,
				kind: "message.received",
				conversationId: "home:test",
				messageId: "message-older",
				runId: "run-message-older",
				payload: { role: "user", content: "older message" },
				createdAt: "2026-06-06T08:02:00.000Z",
			}),
			normalizeKernelRuntimeEventInsert({
				id: "message-oldest",
				organizationId: ORG_ID,
				kind: "message.completed",
				conversationId: "home:test",
				messageId: "message-oldest",
				runId: "run-message-oldest",
				payload: { role: "assistant", content: "oldest message" },
				createdAt: "2026-06-06T08:01:00.000Z",
			}),
		);

		const page = await client.readMessages({
			conversationId: "home:test",
			limit: 2,
		});

		expect(page.messages.map((message) => message.id)).toEqual([
			"message-older",
			"message-newer",
		]);
		expect(page.nextCursor).toBe("2026-06-06T08:02:00.000Z");
	});

	it("serves Home conversations from the durable index once backfilled", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		// Sentinel present ⇒ the projection is authoritative. No kernel events
		// are seeded at all: an old conversation aged out of any event window
		// still lists, which is the whole point of the index.
		db.conversationIndexRows.push(
			normalizeKernelConversationInsert({
				id: `${ORG_ID}:home:new`,
				organizationId: ORG_ID,
				conversationId: "home:new",
				title: "Quarterly numbers",
				titleSource: "rename",
				channel: "home",
				lastMessageAt: "2026-06-06T09:00:00.000Z",
				messageCount: 4,
				createdAt: "2026-06-06T08:00:00.000Z",
				updatedAt: "2026-06-06T09:00:00.000Z",
			}),
			normalizeKernelConversationInsert({
				id: `${ORG_ID}:home:old`,
				organizationId: ORG_ID,
				conversationId: "home:old",
				lastMessageAt: "2026-01-01T00:00:00.000Z",
				messageCount: 2,
				createdAt: "2026-01-01T00:00:00.000Z",
			}),
		);

		const page = await client.listConversations({ limit: 10 });

		expect(page.conversations.map((conversation) => conversation.id)).toEqual([
			"home:new",
			"home:old",
		]);
		expect(page.conversations[0]).toMatchObject({
			title: "Quarterly numbers",
			messageCount: 4,
			lastMessageAt: "2026-06-06T09:00:00.000Z",
			metadata: { titleSource: "rename" },
		});
		// Untitled index rows fall back to id-as-title — the Tedix OS's no-title signal.
		expect(page.conversations[1]?.title).toBe("home:old");
		expect(page.nextCursor).toBeNull();
	});

	it("paginates the durable index with a stable keyset cursor", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		db.conversationIndexRows.push(
			normalizeKernelConversationInsert({
				id: `${ORG_ID}:home:c`,
				organizationId: ORG_ID,
				conversationId: "home:c",
				lastMessageAt: "2026-06-06T09:00:00.000Z",
			}),
			// home:a and home:b share last_message_at — the conversation_id DESC
			// tiebreak makes the page split deterministic.
			normalizeKernelConversationInsert({
				id: `${ORG_ID}:home:b`,
				organizationId: ORG_ID,
				conversationId: "home:b",
				lastMessageAt: "2026-06-06T08:00:00.000Z",
			}),
			normalizeKernelConversationInsert({
				id: `${ORG_ID}:home:a`,
				organizationId: ORG_ID,
				conversationId: "home:a",
				lastMessageAt: "2026-06-06T08:00:00.000Z",
			}),
		);

		const firstPage = await client.listConversations({ limit: 2 });
		expect(
			firstPage.conversations.map((conversation) => conversation.id),
		).toEqual(["home:c", "home:b"]);
		expect(firstPage.nextCursor).toBe("2026-06-06T08:00:00.000Z|home:b");

		const secondPage = await client.listConversations({
			limit: 2,
			cursor: firstPage.nextCursor ?? undefined,
		});
		expect(
			secondPage.conversations.map((conversation) => conversation.id),
		).toEqual(["home:a"]);
		expect(secondPage.nextCursor).toBeNull();
	});

	it("filters the durable index by search without breaking the read", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		db.conversationIndexRows.push(
			normalizeKernelConversationInsert({
				id: `${ORG_ID}:home:alpha`,
				organizationId: ORG_ID,
				conversationId: "home:alpha",
				title: "Alpha rollout",
				titleSource: "autoTitle",
				lastMessageAt: "2026-06-06T09:00:00.000Z",
			}),
			normalizeKernelConversationInsert({
				id: `${ORG_ID}:home:beta`,
				organizationId: ORG_ID,
				conversationId: "home:beta",
				title: "Beta budget",
				titleSource: "autoTitle",
				lastMessageAt: "2026-06-06T08:00:00.000Z",
			}),
		);

		const page = await client.listConversations({ limit: 10, search: "alpha" });

		expect(page.conversations.map((conversation) => conversation.id)).toEqual([
			"home:alpha",
		]);
		expect(page.conversations[0]?.metadata?.titleSource).toBe("autoTitle");
	});

	it("enqueueMessage synchronously stamps a provisional title on the first message of a new conversation", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		kernelRuntimeTestHooks.setDelegateRunnerForTest(async (input) => ({
			childConversationId: "agent:main:main",
			childRunId: input.childRunId,
			status: "queued",
		}));
		try {
			await client.enqueueMessage({
				conversationId: "home:fresh-topic",
				content: "Audit the Q3 globex invoices! Then report back.",
				delegateToTediId: "tedi-echo",
				idempotencyKey: "home-provisional-title-1",
			});
		} finally {
			kernelRuntimeTestHooks.setDelegateRunnerForTest(null);
		}

		// The projection row exists before any settle/auto-title work: a sidebar
		// reload in the first seconds must not show "New chat".
		const row = db.conversationIndexRows.find(
			(candidate) => candidate.conversationId === "home:fresh-topic",
		);
		expect(row).toMatchObject({
			title: "Audit the Q3 globex invoices",
			titleSource: "provisional",
		});
		// Projection-only: no conversation.updated event was written, so the
		// post-settle auto-title guard (count of those events) stays unblocked.
		expect(
			db.events.filter((event) => event.kind === "conversation.updated"),
		).toHaveLength(0);
	});

	/**
	 * End-to-end origin stamp: request principal → `message.received` payload →
	 * projection column → `listConversations` output. The two directions are
	 * tested together because the failure that matters is not "agent traffic is
	 * unlabelled", it is "the operator's own chat got labelled agent".
	 */
	it("enqueueMessage stamps the conversation with the calling principal's origin", async () => {
		const machineDb = createKernelRuntimeDb();
		// The default test context authenticates as an API key — the shape an MCP
		// probe or smoke test arrives in.
		const machineClient = createKernelRuntimeClient(createContext(machineDb));
		await machineClient.enqueueMessage({
			conversationId: "home:probe",
			content: "Count Tedis via MCP",
			idempotencyKey: "home-origin-agent-1",
		});
		expect(
			machineDb.events.find(
				(event) =>
					event.kind === "message.received" &&
					event.conversationId === "home:probe",
			)?.payload,
		).toMatchObject({ origin: "agent" });
		expect(
			machineDb.conversationIndexRows.find(
				(row) => row.conversationId === "home:probe",
			),
		).toMatchObject({ origin: "agent" });

		const operatorDb = createKernelRuntimeDb();
		const operatorContext = {
			...createContext(operatorDb),
			apiKey: undefined,
			authType: "user" as const,
			user: { sub: "operator-1" } as BaseContext["user"],
			userRole: "owner",
		};
		const operatorClient = createKernelRuntimeClient(operatorContext);
		await operatorClient.enqueueMessage({
			conversationId: "home:operator",
			content: "What changed in billing yesterday?",
			idempotencyKey: "home-origin-human-1",
		});
		expect(
			operatorDb.conversationIndexRows.find(
				(row) => row.conversationId === "home:operator",
			),
		).toMatchObject({ origin: "human" });
	});

	/**
	 * Nothing was backfilled, so the projection is full of null-origin rows.
	 * The read path must resolve them to `human` rather than leaking the null
	 * to clients, or every consumer re-derives the default and one of them gets
	 * it backwards.
	 */
	it("listConversations reports an unstamped projection row as human", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		db.conversationIndexRows.push(
			// A pre-stamp row: real history, `origin` never written.
			normalizeKernelConversationInsert({
				id: `${ORG_ID}:home:legacy`,
				organizationId: ORG_ID,
				conversationId: "home:legacy",
				lastMessageAt: "2026-06-06T08:00:00.000Z",
				messageCount: 6,
			}),
		);
		const page = await client.listConversations({ limit: 10 });
		const legacy = page.conversations.find(
			(conversation) => conversation.id === "home:legacy",
		);
		expect(legacy?.origin).toBe("human");
	});

	it("deleteConversation purges the runtime ledger and leaves a hidden tombstone", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		db.conversationIndexRows.push(
			normalizeKernelConversationInsert({
				id: `${ORG_ID}:home:keep`,
				organizationId: ORG_ID,
				conversationId: "home:keep",
				lastMessageAt: "2026-06-06T08:05:00.000Z",
				messageCount: 1,
			}),
			normalizeKernelConversationInsert({
				id: `${ORG_ID}:home:delete-me`,
				organizationId: ORG_ID,
				conversationId: "home:delete-me",
				lastMessageAt: "2026-06-06T08:04:00.000Z",
				messageCount: 1,
			}),
		);
		db.events.push(
			normalizeKernelRuntimeEventInsert({
				id: "keep-msg",
				organizationId: ORG_ID,
				kind: "message.completed",
				conversationId: "home:keep",
				messageId: "keep-msg",
				payload: { role: "assistant", content: "keep me" },
				createdAt: "2026-06-06T08:05:00.000Z",
			}),
			normalizeKernelRuntimeEventInsert({
				id: "delete-msg",
				organizationId: ORG_ID,
				kind: "message.completed",
				conversationId: "home:delete-me",
				messageId: "delete-msg",
				payload: { role: "assistant", content: "delete me" },
				createdAt: "2026-06-06T08:04:00.000Z",
			}),
		);

		const before = await client.listConversations({ limit: 10 });
		expect(before.conversations.map((conversation) => conversation.id)).toEqual(
			["home:keep", "home:delete-me"],
		);

		const result = await client.deleteConversation({
			conversationId: "home:delete-me",
		});
		expect(result.ok).toBe(true);
		expect(result.conversationId).toBe("home:delete-me");
		expect(typeof result.deletedAt).toBe("string");
		expect(result).toMatchObject({ hardDeleted: true, canceledRunCount: 0 });
		expect(db.events.some((event) => event.id === "delete-msg")).toBe(false);
		expect(db.conversationIndexRows).toContainEqual(
			expect.objectContaining({
				conversationId: "home:delete-me",
				title: null,
				messageCount: 0,
				deletedAt: result.deletedAt,
			}),
		);

		const after = await client.listConversations({ limit: 10 });
		expect(after.conversations.map((conversation) => conversation.id)).toEqual([
			"home:keep",
		]);
	});

	it("deleteConversation is idempotent — a second call keeps the conversation hidden without throwing", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		db.conversationIndexRows.push(
			normalizeKernelConversationInsert({
				id: `${ORG_ID}:home:double-delete`,
				organizationId: ORG_ID,
				conversationId: "home:double-delete",
				lastMessageAt: "2026-06-06T08:04:00.000Z",
				messageCount: 1,
			}),
		);
		db.events.push(
			normalizeKernelRuntimeEventInsert({
				id: "double-delete-msg",
				organizationId: ORG_ID,
				kind: "message.completed",
				conversationId: "home:double-delete",
				messageId: "double-delete-msg",
				payload: { role: "assistant", content: "hi" },
				createdAt: "2026-06-06T08:04:00.000Z",
			}),
		);

		await client.deleteConversation({ conversationId: "home:double-delete" });
		await expect(
			client.deleteConversation({ conversationId: "home:double-delete" }),
		).resolves.toMatchObject({ ok: true });

		const page = await client.listConversations({ limit: 10 });
		expect(page.conversations.map((conversation) => conversation.id)).toEqual(
			[],
		);
	});

	it("deleteConversation cancels active parent and delegated child runs before purging them", async () => {
		const db = createKernelRuntimeDb();
		db.conversationIndexRows.push(
			normalizeKernelConversationInsert({
				id: `${ORG_ID}:home:active-delete`,
				organizationId: ORG_ID,
				conversationId: "home:active-delete",
				lastMessageAt: "2026-06-06T08:04:00.000Z",
				messageCount: 1,
			}),
		);
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-active-delete-run",
				organizationId: ORG_ID,
				conversationId: "home:active-delete",
				status: "running",
				delegatedTediId: "tedi-cto",
				childRunId: "child-active-delete-run",
				childConversationId: "child-active-delete-conversation",
				createdAt: "2026-06-06T08:00:00.000Z",
				updatedAt: "2026-06-06T08:01:00.000Z",
			}),
		);
		const stopper = vi.fn(async () => ({
			attempted: true,
			outcome: "succeeded" as const,
		}));
		const canceler = vi.fn(async () => true);
		kernelRuntimeTestHooks.setChildStopperForTest(stopper);
		kernelRuntimeTestHooks.setDoTurnCancelerForTest(canceler);
		const client = createKernelRuntimeClient(createContext(db));

		const result = await client.deleteConversation({
			conversationId: "home:active-delete",
		});

		expect(result).toMatchObject({ hardDeleted: true, canceledRunCount: 1 });
		expect(stopper).toHaveBeenCalledWith(
			expect.objectContaining({ childRunId: "child-active-delete-run" }),
		);
		expect(canceler).toHaveBeenCalledWith(
			expect.objectContaining({ runId: "home-active-delete-run" }),
		);
		expect(db.submissionAbortStamps.map((stamp) => stamp.submissionId)).toEqual(
			["sub:home-active-delete-run", "sub:child-active-delete-run"],
		);
		expect(db.runs).toEqual([]);
		expect(db.events).toEqual([]);
	});

	it("deleteConversation refuses to delete the org's main Home thread", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		await expect(
			client.deleteConversation({ conversationId: "home:main" }),
		).rejects.toThrow(/main Home thread/);
	});

	it("pinConversation writes through pinnedAt to the canonical projection; unpin clears it", async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-06-06T08:05:00.000Z"));
			const db = createKernelRuntimeDb();
			const client = createKernelRuntimeClient(createContext(db));
			db.conversationIndexRows.push(
				normalizeKernelConversationInsert({
					id: `${ORG_ID}:home:pin-me`,
					organizationId: ORG_ID,
					conversationId: "home:pin-me",
					lastMessageAt: "2026-06-06T08:04:00.000Z",
					messageCount: 1,
				}),
			);
			db.events.push(
				normalizeKernelRuntimeEventInsert({
					id: "pin-msg",
					organizationId: ORG_ID,
					kind: "message.completed",
					conversationId: "home:pin-me",
					messageId: "pin-msg",
					payload: { role: "assistant", content: "pin me" },
					createdAt: "2026-06-06T08:04:00.000Z",
				}),
			);

			const pin = await client.pinConversation({
				conversationId: "home:pin-me",
				pinned: true,
			});
			expect(pin.conversation.pinnedAt).toEqual(expect.any(String));

			const pinEvent = db.events.find(
				(event) =>
					event.conversationId === "home:pin-me" &&
					event.kind === "conversation.updated",
			);
			expect(pinEvent?.payload).toMatchObject({
				conversation: { pinned: true },
				pinned: true,
				source: "kernelRuntime.pinConversation",
			});

			const pinned = await client.listConversations({ limit: 10 });
			const pinnedRow = pinned.conversations.find(
				(conversation) => conversation.id === "home:pin-me",
			);
			expect(pinnedRow?.pinnedAt).toEqual(expect.any(String));

			// Unpin (a later action) clears the overlay back to null — not sticky,
			// unlike delete.
			vi.setSystemTime(new Date("2026-06-06T08:06:00.000Z"));
			await client.pinConversation({
				conversationId: "home:pin-me",
				pinned: false,
			});
			const unpinned = await client.listConversations({ limit: 10 });
			const unpinnedRow = unpinned.conversations.find(
				(conversation) => conversation.id === "home:pin-me",
			);
			expect(unpinnedRow).toBeDefined();
			expect(unpinnedRow?.pinnedAt ?? null).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("archiveConversation hides a thread by default and restore keeps its ledger", async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-06-06T08:05:00.000Z"));
			const db = createKernelRuntimeDb();
			const client = createKernelRuntimeClient(createContext(db));
			db.conversationIndexRows.push(
				normalizeKernelConversationInsert({
					id: `${ORG_ID}:home:archive-me`,
					organizationId: ORG_ID,
					conversationId: "home:archive-me",
					lastMessageAt: "2026-06-06T08:04:00.000Z",
					messageCount: 1,
				}),
			);
			db.events.push(
				normalizeKernelRuntimeEventInsert({
					id: "archive-msg",
					organizationId: ORG_ID,
					kind: "message.completed",
					conversationId: "home:archive-me",
					messageId: "archive-msg",
					payload: { role: "assistant", content: "keep this ledger" },
					createdAt: "2026-06-06T08:04:00.000Z",
				}),
			);

			const archived = await client.archiveConversation({
				conversationId: "home:archive-me",
				archived: true,
			});
			expect(archived.conversation.status).toBe("archived");
			expect(
				(await client.listConversations({ limit: 10 })).conversations,
			).toEqual([]);
			expect(
				(
					await client.listConversations({
						limit: 10,
						includeArchived: true,
					})
				).conversations[0],
			).toMatchObject({ id: "home:archive-me", status: "archived" });
			expect(db.events.some((event) => event.id === "archive-msg")).toBe(true);

			vi.setSystemTime(new Date("2026-06-06T08:06:00.000Z"));
			const restored = await client.archiveConversation({
				conversationId: "home:archive-me",
				archived: false,
			});
			expect(restored.conversation.status).toBe("active");
			expect(
				(await client.listConversations({ limit: 10 })).conversations[0],
			).toMatchObject({ id: "home:archive-me", status: "active" });
		} finally {
			vi.useRealTimers();
		}
	});

	it("listConversations hides ephemeral CI-smoke conversations", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		db.conversationIndexRows.push(
			normalizeKernelConversationInsert({
				id: `${ORG_ID}:home:real-chat`,
				organizationId: ORG_ID,
				conversationId: "home:real-chat",
				lastMessageAt: "2026-06-06T08:05:00.000Z",
				messageCount: 1,
			}),
			normalizeKernelConversationInsert({
				id: `${ORG_ID}:home:mcp-tasks-live-smoke-1783486327344`,
				organizationId: ORG_ID,
				conversationId: "home:mcp-tasks-live-smoke-1783486327344",
				lastMessageAt: "2026-06-06T08:04:00.000Z",
				messageCount: 1,
			}),
		);
		db.events.push(
			normalizeKernelRuntimeEventInsert({
				id: "real-msg",
				organizationId: ORG_ID,
				kind: "message.completed",
				conversationId: "home:real-chat",
				messageId: "real-msg",
				payload: { role: "assistant", content: "keep" },
				createdAt: "2026-06-06T08:05:00.000Z",
			}),
			normalizeKernelRuntimeEventInsert({
				id: "smoke-msg",
				organizationId: ORG_ID,
				kind: "message.completed",
				conversationId: "home:mcp-tasks-live-smoke-1783486327344",
				messageId: "smoke-msg",
				payload: { role: "assistant", content: "noise" },
				createdAt: "2026-06-06T08:04:00.000Z",
			}),
		);

		const page = await client.listConversations({ limit: 10 });
		expect(page.conversations.map((conversation) => conversation.id)).toEqual([
			"home:real-chat",
		]);
	});

	it("deleteConversation requires edit grants once a conversation opts into scoped access", async () => {
		const db = createKernelRuntimeDb({
			grantRows: [
				grantRow({
					access: "read",
					conversationId: "home:locked-delete",
					userId: "operator-1",
				}),
			],
		});
		const reader = createKernelRuntimeClient(
			createContext(db, { userSub: "operator-1" }),
		);
		await expect(
			reader.deleteConversation({ conversationId: "home:locked-delete" }),
		).rejects.toThrow(/Access denied/);

		db.grantRows[0].access = "edit";
		await expect(
			reader.deleteConversation({ conversationId: "home:locked-delete" }),
		).resolves.toMatchObject({ ok: true });
	});

	it("fails closed on conversation reads and writes before the shared D1 table is migrated", async () => {
		const client = createKernelRuntimeClient(
			createContext(
				createMissingKernelRuntimeTableDb() as ReturnType<
					typeof createKernelRuntimeDb
				>,
			),
		);

		await expect(client.listConversations({ limit: 10 })).rejects.toThrow(
			/no such table: kernel_conversations/,
		);
		await expect(
			client.readMessages({
				conversationId: "home:main",
				limit: 10,
			}),
		).rejects.toThrow(/Access denied/);
		await expect(
			client.enqueueMessage({
				conversationId: "home:main",
				content: "This must not bypass the unreadable ACL",
				idempotencyKey: "home-missing-table-1",
			}),
		).rejects.toThrow(/Access denied/);
	});

	it.each(["cancel", "change"] as const)(
		"explains a late %s in plain English without changing the finished reply",
		async (action) => {
			const db = createKernelRuntimeDb();
			db.runs.push(
				normalizeKernelRuntimeRunInsert({
					id: "home-finished-control",
					organizationId: ORG_ID,
					conversationId: "home:finished-control",
					status: "completed",
					preview: "Your answer is ready.",
				}),
			);
			const client = createKernelRuntimeClient(createContext(db));
			await expect(
				action === "cancel"
					? client.cancelRun({ runId: "home-finished-control" })
					: client.steerRun({
							runId: "home-finished-control",
							instruction: "Make it shorter",
						}),
			).rejects.toThrow(
				"That reply has already ended. Send a new message to continue.",
			);
			expect(db.runs[0]?.status).toBe("completed");
			expect(db.runs[0]?.preview).toBe("Your answer is ready.");
			expect(db.events).toHaveLength(0);
		},
	);

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

	describe("resolvePageTool", () => {
		const MEMBER = "member-1";
		const OTHER_MEMBER = "member-2";
		const pageResult = { ok: true, content: "filled" };
		function pageToolRun(input: {
			id: string;
			startedBy?: string | null;
			status?: "running" | "completed";
			organizationId?: string;
		}) {
			return normalizeKernelRuntimeRunInsert({
				id: input.id,
				organizationId: input.organizationId ?? ORG_ID,
				conversationId: `home:${input.id}`,
				status: input.status ?? "running",
				metadata:
					input.startedBy === null
						? { source: "kernelRuntime.enqueueMessage" }
						: {
								source: "kernelRuntime.enqueueMessage",
								redriveInput: { descopeUserId: input.startedBy ?? MEMBER },
							},
				createdAt: "2026-06-06T08:00:00.000Z",
				updatedAt: "2026-06-06T08:01:00.000Z",
			});
		}
		/** A real broker: the call id is single-use and bound to its run. */
		function fakeKernel(broker: PageToolBroker) {
			return {
				idFromName: (name: string) => name,
				get: (doId: string) => ({
					resolvePageTool: async (
						runId: string,
						callId: string,
						result: { ok: boolean; content: string },
					) => doId === ORG_ID && (await broker.resolve(runId, callId, result)),
				}),
			};
		}
		async function openCall(broker: PageToolBroker, runId: string) {
			let emitted: (callId: string) => void = () => {};
			const callId = new Promise<string>((resolve) => {
				emitted = resolve;
			});
			const settled = broker.request({
				runId,
				name: "fill_card",
				args: {},
				confirm: false,
				emit: (event) => emitted(String(event.callId)),
			});
			return { callId: await callId, settled };
		}
		function memberClient(
			db: ReturnType<typeof createKernelRuntimeDb>,
			broker: PageToolBroker,
			overrides?: {
				userSub?: string;
				userRole?: "member" | "viewer" | "admin";
			},
		) {
			return createKernelRuntimeClient({
				...createContext(db, {
					userSub: overrides?.userSub ?? MEMBER,
					env: { KERNEL: fakeKernel(broker) },
				}),
				apiKey: undefined,
				authType: "user" as const,
				userRole: overrides?.userRole ?? ("member" as const),
			});
		}

		it("lets a member answer an open call on the running run they started, once", async () => {
			const db = createKernelRuntimeDb();
			db.runs.push(pageToolRun({ id: "page-own" }));
			const broker = new PageToolBroker();
			const { callId, settled } = await openCall(broker, "page-own");
			const client = memberClient(db, broker);

			await expect(
				client.resolvePageTool({
					runId: "page-own",
					callId,
					result: pageResult,
				}),
			).resolves.toEqual({ accepted: true });
			await expect(settled).resolves.toEqual(pageResult);
			// The same call id a second time settles nothing (single use).
			await expect(
				client.resolvePageTool({
					runId: "page-own",
					callId,
					result: { ok: true, content: "replayed" },
				}),
			).resolves.toEqual({ accepted: false });
			// A guessed call id settles nothing either.
			await expect(
				client.resolvePageTool({
					runId: "page-own",
					callId: "call-guessed-1",
					result: pageResult,
				}),
			).resolves.toEqual({ accepted: false });
		});

		it("lets a member answer a shared conversation they were granted edit on", async () => {
			const db = createKernelRuntimeDb({
				grantRows: [
					grantRow({
						access: "owner",
						conversationId: "home:page-shared",
						userId: OTHER_MEMBER,
					}),
					grantRow({
						access: "edit",
						conversationId: "home:page-shared",
						userId: MEMBER,
					}),
				],
			});
			db.runs.push(pageToolRun({ id: "page-shared" }));
			const broker = new PageToolBroker();
			const { callId } = await openCall(broker, "page-shared");

			await expect(
				memberClient(db, broker).resolvePageTool({
					runId: "page-shared",
					callId,
					result: pageResult,
				}),
			).resolves.toEqual({ accepted: true });
		});

		it("refuses a member on another person's run, even in an org-wide conversation", async () => {
			const db = createKernelRuntimeDb();
			db.runs.push(pageToolRun({ id: "page-other", startedBy: OTHER_MEMBER }));
			db.runs.push(
				pageToolRun({ id: "page-unknown-starter", startedBy: null }),
			);
			const broker = new PageToolBroker();
			const { callId, settled } = await openCall(broker, "page-other");
			const client = memberClient(db, broker);

			await expect(
				client.resolvePageTool({
					runId: "page-other",
					callId,
					result: pageResult,
				}),
			).rejects.toMatchObject({
				code: "FORBIDDEN",
				message:
					"Only the person who started this Home run can answer its page tools",
			});
			// A run with no recorded starter is nobody's to answer.
			await expect(
				client.resolvePageTool({
					runId: "page-unknown-starter",
					callId,
					result: pageResult,
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			// An admin is a person too: the page is the starter's, not the org's.
			await expect(
				memberClient(db, broker, { userRole: "admin" }).resolvePageTool({
					runId: "page-other",
					callId,
					result: pageResult,
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			await expect(
				Promise.race([settled, Promise.resolve("still open")]),
			).resolves.toBe("still open");
		});

		it("refuses a member the conversation grants exclude, before the run is touched", async () => {
			const db = createKernelRuntimeDb({
				grantRows: [
					grantRow({
						access: "owner",
						conversationId: "home:page-locked",
						userId: OTHER_MEMBER,
					}),
				],
			});
			db.runs.push(pageToolRun({ id: "page-locked" }));
			const broker = new PageToolBroker();
			const { callId } = await openCall(broker, "page-locked");

			await expect(
				memberClient(db, broker).resolvePageTool({
					runId: "page-locked",
					callId,
					result: pageResult,
				}),
			).rejects.toMatchObject({
				code: "FORBIDDEN",
				message: "Access denied to Home conversation home:page-locked",
			});
		});

		it("refuses a viewer (no os:run) and a run in another organization", async () => {
			const db = createKernelRuntimeDb();
			db.runs.push(pageToolRun({ id: "page-viewer" }));
			db.runs.push(
				pageToolRun({ id: "page-elsewhere", organizationId: "org-2" }),
			);
			const broker = new PageToolBroker();
			const { callId } = await openCall(broker, "page-viewer");

			await expect(
				memberClient(db, broker, { userRole: "viewer" }).resolvePageTool({
					runId: "page-viewer",
					callId,
					result: pageResult,
				}),
			).rejects.toMatchObject({
				code: "FORBIDDEN",
				message: "Insufficient permissions. Required: os:run",
			});
			await expect(
				memberClient(db, broker).resolvePageTool({
					runId: "page-elsewhere",
					callId,
					result: pageResult,
				}),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
		});

		it("accepts nothing for a finished run or a missing run", async () => {
			const db = createKernelRuntimeDb();
			db.runs.push(pageToolRun({ id: "page-done", status: "completed" }));
			const broker = new PageToolBroker();
			const resolve = vi.spyOn(broker, "resolve");
			const client = memberClient(db, broker);

			await expect(
				client.resolvePageTool({
					runId: "page-done",
					callId: "call-00000001",
					result: pageResult,
				}),
			).resolves.toEqual({ accepted: false });
			await expect(
				client.resolvePageTool({
					runId: "page-missing",
					callId: "call-00000001",
					result: pageResult,
				}),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			expect(resolve).not.toHaveBeenCalled();
		});

		it("refuses tedi callers: the page is the person's, not the worker's", async () => {
			const db = createKernelRuntimeDb();
			db.runs.push(pageToolRun({ id: "page-tedi" }));
			const broker = new PageToolBroker();
			const resolve = vi.spyOn(broker, "resolve");
			const { callId } = await openCall(broker, "page-tedi");
			const base = createContext(db, { env: { KERNEL: fakeKernel(broker) } });
			const tediCallers: BaseContext[] = [
				// The MCP edge forwarding a tedi's declared tool over the service
				// binding: withAuth resolves the principal from these headers.
				{
					...base,
					apiKey: undefined,
					authType: undefined,
					headers: new Headers({
						"X-Service-Binding": "true",
						"X-Tedix-Org-Id": ORG_ID,
						"X-Tedix-Tedi-Id": "tedi-cto",
						"X-Tedix-Tedi-Scopes": "tedis:write",
						"X-Tedix-Mcp-Tool-Id": "resolve_page_tool",
					}),
				} as unknown as BaseContext,
				// A direct tedi JWT (what authenticateTediJwt leaves on the context).
				{
					...base,
					apiKey: undefined,
					authType: "tedi",
					tediId: "tedi-cto",
					descopeUserId: "tedi-cto-identity",
					tediScopes: ["tedis:write"],
					user: { sub: "tedi-cto-identity" } as BaseContext["user"],
				} as BaseContext,
			];
			for (const context of tediCallers) {
				await expect(
					createKernelRuntimeClient(context).resolvePageTool({
						runId: "page-tedi",
						callId,
						result: pageResult,
					}),
				).rejects.toMatchObject({
					code: "FORBIDDEN",
					message:
						"Page tools are answered by the person's page, never by a tedi",
				});
			}
			expect(resolve).not.toHaveBeenCalled();
		});
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
