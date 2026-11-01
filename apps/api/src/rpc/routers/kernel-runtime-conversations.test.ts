import "./__tests__/kernel-runtime-work-mocks";
import { describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { kernelRuntimeTestHooks } from "./kernel-runtime/policy-normalization";
import {
	ORG_ID,
	normalizeKernelConversationInsert,
	normalizeKernelRuntimeEventInsert,
	normalizeKernelRuntimeRunInsert,
	createKernelRuntimeDb,
	createMissingKernelRuntimeTableDb,
	createContext,
	createKernelRuntimeClient,
	grantRow,
} from "./__tests__/kernel-runtime-db";

describe("kernel runtime router: conversations", () => {
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
});
