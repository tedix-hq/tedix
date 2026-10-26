import "./__tests__/kernel-runtime-work-mocks";
import { describe, expect, it } from "vite-plus/test";
import { normalizeHomeRunRecord } from "./kernel/run-store-normalization";
import { readChildRunStatuses } from "./kernel-runtime/run-reads-streams";
import {
	ORG_ID,
	normalizeKernelRuntimeEventInsert,
	normalizeKernelRuntimeRunInsert,
	createKernelRuntimeDb,
	createContext,
	createKernelRuntimeClient,
} from "./__tests__/kernel-runtime-db";

describe("kernel runtime router: transcript", () => {
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
});
