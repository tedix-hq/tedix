import "./__tests__/kernel-runtime-work-mocks";
import * as kernelRequestQueries from "@tedix/db/queries/kernel-requests";
import * as kernelRequestSource from "../../kernel/request-home-source";
import { receivedKernelRequest } from "../../kernel/request-coordinator";
import { describe, expect, it, vi } from "vite-plus/test";
import { kernelRuntimeTestHooks } from "./kernel-runtime/policy-normalization";
import {
	ORG_ID,
	normalizeKernelRuntimeEventInsert,
	normalizeKernelRuntimeRunInsert,
	isRuntimeEventSource,
	createKernelRuntimeDb,
	createContext,
	createKernelRuntimeClient,
	childRuntimeEvent,
} from "./__tests__/kernel-runtime-db";

describe("kernel runtime router: run-sets", () => {
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
});
