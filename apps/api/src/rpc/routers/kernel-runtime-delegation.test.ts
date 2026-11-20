import "./__tests__/kernel-runtime-work-mocks";
import { describe, expect, it, vi } from "vite-plus/test";
import * as eventQueries from "@tedix/db/queries/kernel-runtime-events";
import type { BaseContext } from "../orpc";
import {
	delegationMetadataForPick,
	delegationSessionKeyForDispatch,
	kernelRuntimeTestHooks,
} from "./kernel-runtime/policy-normalization";
import {
	agentRunEndedHomeMessage,
	enqueueHomeMessage,
} from "../../services/agent-run-ended-notice";
import { buildInternalServiceBindingContext } from "./kernel/runtime-shared";
import {
	ORG_ID,
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

	it("marks the dispatch as picked by a person only for a signed-in person in Tedix OS", async () => {
		const dispatches: Array<{
			pickedByPerson?: boolean;
			metadata: Record<string, unknown>;
		}> = [];
		kernelRuntimeTestHooks.setDelegateRunnerForTest(async (input) => {
			dispatches.push(input);
			return {
				childConversationId: "agent:main:main",
				childRunId: input.childRunId,
				status: "queued",
			};
		});
		const person = (headers = new Headers()) => ({
			...createContext(createKernelRuntimeDb(), { userSub: "operator-1" }),
			apiKey: undefined,
			authType: "user" as const,
			userRole: "owner",
			headers,
		});
		const send = (context: BaseContext, idempotencyKey: string) =>
			createKernelRuntimeClient(context).enqueueMessage({
				conversationId: "home:os:chat-7",
				content: "Ask the CPO to validate the deploy plan",
				delegateToTediId: "tedi-cpo",
				idempotencyKey,
				// A caller cannot claim the pick through request metadata.
				metadata: { pickedByPerson: true },
			});

		await send(person(), "home-pick-person");
		// The same person's credential replayed through the MCP gateway, and an
		// API key, are programmatic callers.
		await send(
			person(new Headers({ "X-Tedix-Mcp-Tool-Id": "ask" })),
			"home-pick-mcp",
		);
		await send(createContext(createKernelRuntimeDb()), "home-pick-apikey");

		expect(dispatches.map((dispatch) => dispatch.pickedByPerson)).toEqual([
			true,
			false,
			false,
		]);
		for (const dispatch of dispatches) {
			expect(dispatch.metadata).not.toHaveProperty("pickedByPerson");
			expect(dispatch.metadata).toMatchObject({
				source: "kernelRuntime.delegate",
				homeConversationId: "home:os:chat-7",
			});
		}
	});

	it("carries the pick to the tedi only from the dispatch's own argument", () => {
		const supplied = { pickedByPerson: true, homeRunId: "home-1" };
		expect(delegationMetadataForPick(supplied, true)).toEqual({
			pickedByPerson: true,
			homeRunId: "home-1",
		});
		expect(delegationMetadataForPick(supplied, false)).toEqual({
			homeRunId: "home-1",
		});
		expect(delegationMetadataForPick(supplied, undefined)).toEqual({
			homeRunId: "home-1",
		});
		// The turn's model follows the same rule: a model that arrived in the
		// metadata never reaches the tedi, checked or not.
		const withModel = { turnModel: { modelRef: "azure-openai/unchecked" } };
		expect(delegationMetadataForPick(withModel, true)).toEqual({
			pickedByPerson: true,
		});
		expect(
			delegationMetadataForPick(withModel, true, "azure-openai/gpt-6.1-sol"),
		).toEqual({
			pickedByPerson: true,
			turnModel: { modelRef: "azure-openai/gpt-6.1-sol" },
		});
		expect(
			delegationMetadataForPick(withModel, false, "azure-openai/gpt-6.1-sol"),
		).toEqual({});
	});

	it("keeps one tedi session per chat for a picked tedi and a fresh one otherwise", async () => {
		const key = (
			childRunId: string,
			pickedByPerson: boolean,
			homeConversationId = "home:os:chat-7",
		) =>
			delegationSessionKeyForDispatch({
				childRunId,
				pickedByPerson,
				homeConversationId,
			});
		const first = await key("run-1:delegate:tedi-cpo", true);
		expect(first).toMatch(/^agent:main:chat-[0-9a-f]{32}$/);
		expect(await key("run-2:delegate:tedi-cpo", true)).toBe(first);
		expect(
			await key("run-3:delegate:tedi-cpo", true, "home:os:chat-8"),
		).not.toBe(first);
		// A retry of the picked turn and a notice about a run the tedi started
		// there continue the same session.
		expect(await key("work-1:retry:1", true)).toBe(first);
		expect(
			await delegationSessionKeyForDispatch({
				childRunId: "agent-run-ended-attempt-1:delegate:tedi-cpo",
				pickedByPerson: false,
				conversationNotice: true,
				homeConversationId: "home:os:chat-7",
			}),
		).toBe(first);
		// A delegation Home decided itself keeps a session per run.
		expect(await key("run-4:delegate:tedi-cpo", false)).toBe(
			"agent:main:delegation-run-4_delegate_tedi-cpo",
		);
	});

	it("returns the picked tedi's run-ended reply to the original chat", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const conversationId = "home:os:chat-7";
		const childRunId =
			"tedi-cpo:mcp:agent-run-ended-attempt-1_delegate_tedi-cpo";
		const dispatch = vi.fn(async () => ({
			childConversationId: "agent:main:main",
			childRunId,
			status: "queued" as const,
		}));
		kernelRuntimeTestHooks.setDelegateRunnerForTest(dispatch);
		const notice = agentRunEndedHomeMessage(
			{
				id: "work-1",
				orgId: ORG_ID,
				title: "Rename the button",
				sourceSessionKey: conversationId,
				stewardType: "tedi",
				stewardId: "tedi-cpo",
			},
			{
				id: "attempt-1",
				executorType: "external_agent",
				outcome: "succeeded",
				summary: null,
			},
		);
		const result = await enqueueHomeMessage(
			buildInternalServiceBindingContext(context, ORG_ID),
			notice!,
		);
		expect(result).toMatchObject({
			status: "queued",
			conversationId,
			run: { delegatedTediId: "tedi-cpo", childRunId },
		});
		expect(dispatch).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				delegateToTediId: "tedi-cpo",
				pickedByPerson: false,
				content: notice!.content,
				metadata: expect.objectContaining({
					agentRunEnded: true,
					homeConversationId: conversationId,
				}),
			}),
		);
		expect(db.events).toContainEqual(
			expect.objectContaining({
				kind: "message.received",
				conversationId,
				payload: expect.objectContaining({
					metadata: expect.objectContaining({ source: "platform" }),
				}),
			}),
		);

		const answer = "I got the result. The button was renamed successfully.";
		db.runtimeEvents.push(
			childRuntimeEvent({
				createdAt: "2026-06-06T08:01:00.000Z",
				id: "notice-answer",
				kind: "message.completed",
				payload: { role: "assistant", content: answer },
				runId: childRunId,
				tediId: "tedi-cpo",
			}),
			childRuntimeEvent({
				createdAt: "2026-06-06T08:01:01.000Z",
				id: "notice-completed",
				kind: "run.completed",
				payload: { status: "completed" },
				runId: childRunId,
				tediId: "tedi-cpo",
			}),
		);
		const client = createKernelRuntimeClient(context);
		await client.readRunSet({ conversationId, limit: 10 });
		const { messages } = await client.readMessages({
			conversationId,
			limit: 10,
		});
		expect(
			messages
				.filter(({ role }) => role === "assistant")
				.map(({ content }) => content),
		).toEqual([answer]);
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
				childRunStatus: "queued",
				delegationFailure: {
					ok: false,
					status: "failed",
					reason: "dispatch_failed",
					error: "isolate dispatch unavailable",
					retryable: false,
					childStillRunning: true,
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
					childRunStatus: "queued",
					delegationFailure: {
						ok: false,
						status: "failed",
						reason: "dispatch_failed",
						error: "isolate dispatch unavailable",
						retryable: false,
						childStillRunning: true,
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

		const attemptsBeforeTimeout = structuredClone(db.workAttemptRows);
		// One empty event page is a sighting, not a verdict: the row stays live
		// with the sighting stamped, and a second quiet look a minute later seals it.
		const firstLook = await client.readRunSet({
			conversationId: "home:test",
			limit: 10,
		});
		expect(
			firstLook.runSet.runs.find(
				(candidate) => candidate.id === "home-delegate-stale-1",
			)?.status,
		).toBe("queued");
		const stamped = (runRow?.metadata ?? {}) as Record<string, unknown>;
		expect(typeof stamped.staleDispatchObservedAt).toBe("string");
		stamped.staleDispatchObservedAt = "2000-01-01T00:00:00.000Z";
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
				childRunStatus: "queued",
				delegationFailure: {
					ok: false,
					status: "failed",
					reason: "dispatch_failed",
					error:
						"Delegated child dispatch timed out before the child runtime published events",
					retryable: false,
					childStillRunning: true,
				},
				source: "kernelRuntime.delegateDispatch",
			},
		});

		expect(db.workAttemptRows).toEqual(attemptsBeforeTimeout);
		await client.readRunSet({ conversationId: "home:test", limit: 10 });
		expect(db.workAttemptRows).toEqual(attemptsBeforeTimeout);
		await expect(client.retryRun({ runId: result.run.id })).rejects.toThrow(
			/original delegated child may still execute/,
		);

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
					childRunStatus: "queued",
					delegationFailure: {
						ok: false,
						status: "failed",
						reason: "dispatch_failed",
						error:
							"Delegated child dispatch timed out before the child runtime published events",
						retryable: false,
						childStillRunning: true,
					},
				},
			},
		});
	});

	it.each([
		["empty", "events"],
		["completed", "events"],
		["empty", "mapping"],
	] as const)(
		"reconciles a healthy %s ledger after a child %s outage without false terminal writes",
		async (recovery, outage) => {
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
				content: "Ask CPO to check the result",
				delegateToTediId: "tedi-cpo",
				idempotencyKey: "home-outage",
			});
			await Promise.all(context.waitUntilPromises);
			const row = db.runs.find((candidate) => candidate.id === result.run.id)!;
			if (outage === "mapping")
				row.runtimeMetadata = {
					...row.runtimeMetadata,
					dispatch: "workstation-dispatched",
				};
			Object.assign(row, {
				createdAt: "2000-01-01T00:00:00.000Z",
				startedAt: "2000-01-01T00:00:00.000Z",
				updatedAt: "2000-01-01T00:00:00.000Z",
			});
			const before = structuredClone({
				row,
				events: db.events,
				attempts: db.workAttemptRows,
			});
			const readError = new Error(
				"D1_ERROR: Failed to parse body as JSON, got: Error: Network connection lost.",
			);
			const mapping =
				outage === "mapping"
					? vi
							.spyOn(eventQueries, "getChatDispatchMappingByIdempotencyKey")
							.mockRejectedValue(readError)
					: null;
			if (outage === "events") db.controls.childRuntimeSelectError = readError;
			try {
				await client.readRunSet({ conversationId: "home:test", limit: 10 });
				await client.readRun({ runId: row.id });
				expect({
					row,
					events: db.events,
					attempts: db.workAttemptRows,
				}).toEqual(before);
			} finally {
				mapping?.mockRestore();
			}
			db.controls.childRuntimeSelectError = null;
			if (recovery === "completed") {
				db.runtimeEvents.push(
					childRuntimeEvent({
						id: "outage-answer",
						kind: "message.completed",
						createdAt: "2026-06-06T08:01:00.000Z",
						payload: {
							role: "assistant",
							content: "The requested result is verified.",
						},
						runId: row.childRunId!,
						tediId: "tedi-cpo",
					}),
					childRuntimeEvent({
						id: "outage-completed",
						kind: "run.completed",
						createdAt: "2026-06-06T08:01:01.000Z",
						runId: row.childRunId!,
						tediId: "tedi-cpo",
					}),
				);
			}
			if (recovery === "empty") {
				// The first healthy read only stamps the quiet sighting.
				const sighting = await client.readRunSet({
					conversationId: "home:test",
					limit: 10,
				});
				expect(
					sighting.runSet.runs.find((run) => run.id === row.id)?.status,
				).toBe("queued");
				(row.metadata as Record<string, unknown>).staleDispatchObservedAt =
					"2000-01-01T00:00:00.000Z";
			}
			const recovered = await client.readRunSet({
				conversationId: "home:test",
				limit: 10,
			});
			expect(
				recovered.runSet.runs.find((run) => run.id === row.id)?.status,
			).toBe(recovery === "completed" ? "completed" : "failed");
			if (recovery === "empty")
				expect(db.workAttemptRows).toEqual(before.attempts);
		},
	);

	it("shows only the picked tedi’s answer and keeps its outcome on the run", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient({
			...createContext(db, { userSub: "operator-1" }),
			apiKey: undefined,
			authType: "user",
			userRole: "owner",
			headers: new Headers(),
		});
		const conversationId = "home:os:chat-7";
		const childRunId = "tedi-cpo:mcp:home-pick-reply_delegate_tedi-cpo";
		kernelRuntimeTestHooks.setDelegateRunnerForTest(async () => ({
			childConversationId: "agent:main:main",
			childRunId,
			status: "queued",
		}));

		const queued = await client.enqueueMessage({
			conversationId,
			content: "What remains on the deploy plan?",
			delegateToTediId: "tedi-cpo",
			idempotencyKey: "home-pick-reply",
		});
		expect(queued.assistantMessage).toMatchObject({
			content: "",
			metadata: { metadata: { homeNarration: "delegation_ack" } },
		});

		const answer = "The deploy plan still needs a rollback step.";
		db.runtimeEvents.push(
			childRuntimeEvent({
				createdAt: "2026-06-06T08:01:00.000Z",
				id: "picked-tedi-answer",
				kind: "message.completed",
				payload: {
					role: "assistant",
					content: `Outcome: needs_follow_up — ${answer}`,
				},
				runId: childRunId,
				tediId: "tedi-cpo",
			}),
			childRuntimeEvent({
				createdAt: "2026-06-06T08:01:01.000Z",
				id: "picked-tedi-completed",
				kind: "run.completed",
				payload: { status: "completed" },
				runId: childRunId,
				tediId: "tedi-cpo",
			}),
		);

		await client.readRunSet({ conversationId, limit: 10 });
		const { messages } = await client.readMessages({
			conversationId,
			limit: 10,
		});
		expect(
			messages
				.filter((message) => message.role === "assistant")
				.map((message) => message.content),
		).toEqual([answer]);
		const { runSet } = await client.readRunSet({ conversationId, limit: 10 });
		expect(runSet.runs).toContainEqual(
			expect.objectContaining({
				id: queued.run.id,
				metadata: expect.objectContaining({
					childRunPreview: answer,
					childTaskOutcome: "needs_follow_up",
				}),
			}),
		);
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
