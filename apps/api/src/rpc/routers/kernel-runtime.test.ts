import "./__tests__/kernel-runtime-work-mocks";
import { HomeRunSteering } from "../../kernel/run-steering";
import { LOCAL_DEMO_PROJECT_ID } from "@tedix/auth/local-demo";
import { kernelRuntimeEvents } from "@tedix/db/schema";
import { describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { assembleHomeContext } from "./kernel/context-assembly";
import { insertKernelRuntimeEvent } from "./kernel/run-store";
import { homeRuntimeEventId } from "@tedix/api-contract/utils/runtime-events";
import { kernelRuntimeTestHooks } from "./kernel-runtime/policy-normalization";
import {
	ORG_ID,
	WORKSTATION_EXECUTION_REQUIREMENT,
	normalizeKernelRuntimeEventInsert,
	normalizeKernelRuntimeRunInsert,
	createKernelRuntimeDb,
	createContext,
	createKernelRuntimeClient,
	childRuntimeEvent,
	grantRow,
} from "./__tests__/kernel-runtime-db";

describe("kernel runtime router: core", () => {
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
});
