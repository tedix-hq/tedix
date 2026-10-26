import "./__tests__/kernel-runtime-work-mocks";
import {
	findWorkItemsBlockedBy,
	queryWorkItemBlockers,
} from "@tedix/db/queries/work-items/relations";
import { describe, expect, it, vi } from "vite-plus/test";
import { kernelRuntimeTestHooks } from "./kernel-runtime/policy-normalization";
import {
	createKernelRuntimeDb,
	createContext,
	createKernelRuntimeClient,
	childRuntimeEvent,
	planAssignmentSeed,
	seedDependencyPlanRun,
} from "./__tests__/kernel-runtime-db";

describe("kernel runtime router: plans", () => {
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
});
