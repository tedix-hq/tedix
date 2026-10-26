import "./__tests__/kernel-runtime-work-mocks";
import { describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { kernelRuntimeTestHooks } from "./kernel-runtime/policy-normalization";
import {
	createKernelRuntimeDb,
	createContext,
	createKernelRuntimeClient,
	childRuntimeEvent,
} from "./__tests__/kernel-runtime-db";

describe("kernel runtime router: delegation", () => {
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
});
