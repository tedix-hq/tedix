import { DatabaseSync } from "node:sqlite";
import { createDbClient, type DbClient } from "@tedix/db/client";
import {
	type KernelConversation,
	type kernelRuntimeEvents as kernelRuntimeEventsTable,
	kernelConversationOriginOrHuman,
	kernelConversations,
} from "@tedix/db/schema";
import { describe, expect, it } from "vite-plus/test";
import {
	applyKernelConversationEvent,
	encodeKernelConversationCursor,
	KERNEL_AUTO_TITLE_SOURCE,
	parseKernelConversationCursor,
	selectKernelConversationIndexPage,
} from "./conversation-index";

/**
 * Durable Home conversation index against REAL in-memory SQLite via the
 * production createDbClient path (no fake D1): the sql`` CASE merge clauses in
 * the write-through/backfill upserts and the keyset cursor row comparison are
 * exactly what the kernel-runtime fake-D1 harness cannot evaluate — this suite
 * is their behavioral proof.
 */

const REAL_DDL = `
CREATE TABLE kernel_runtime_events (
	id TEXT PRIMARY KEY NOT NULL,
	organization_id TEXT NOT NULL,
	kind TEXT NOT NULL,
	conversation_id TEXT NOT NULL,
	run_id TEXT,
	message_id TEXT,
	delegated_tedi_id TEXT,
	child_run_id TEXT,
	sequence INTEGER,
	delta TEXT,
	payload TEXT,
	runtime_backend TEXT NOT NULL DEFAULT 'custom',
	runtime_external_id TEXT,
	runtime_external_url TEXT,
	runtime_metadata TEXT,
	trace_id TEXT,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE TABLE kernel_conversations (
	id TEXT PRIMARY KEY NOT NULL,
	organization_id TEXT NOT NULL,
	conversation_id TEXT NOT NULL,
	title TEXT,
	title_source TEXT,
	channel TEXT,
	origin TEXT,
	workspace_id TEXT,
	workpiece_kind TEXT,
	workpiece_id TEXT,
	last_message_at TEXT NOT NULL,
	message_count INTEGER NOT NULL DEFAULT 0,
	deleted_at TEXT,
	archived_at TEXT,
	pinned_at TEXT,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE UNIQUE INDEX idx_kernel_conversations_org_conversation
	ON kernel_conversations (organization_id, conversation_id);
CREATE INDEX idx_kernel_conversations_org_last_message
	ON kernel_conversations (organization_id, last_message_at, conversation_id);
CREATE INDEX idx_kernel_conversations_org_workspace_last_message
	ON kernel_conversations (organization_id, workspace_id, last_message_at, conversation_id);
`;

function d1Facade(db: DatabaseSync): D1Database {
	const wrap = (sql: string) => {
		const stmt = db.prepare(sql);
		let bound: Array<null | number | bigint | string | Uint8Array> = [];
		const ps = {
			bind: (...vals: unknown[]) => {
				bound = vals as Array<null | number | bigint | string | Uint8Array>;
				return ps;
			},
			all: async () => ({
				results: stmt.all(...bound),
				success: true,
				meta: {},
			}),
			run: async () => {
				const r = stmt.run(...bound);
				return {
					success: true,
					meta: {
						changes: Number(r.changes),
						last_row_id: Number(r.lastInsertRowid),
						duration: 0,
					},
				};
			},
			first: async (col?: string) => {
				const row = stmt.get(...bound) as Record<string, unknown> | undefined;
				return col ? (row?.[col] ?? null) : (row ?? null);
			},
			raw: async () =>
				(stmt.all(...bound) as Array<Record<string, unknown>>).map((r) =>
					Object.values(r),
				),
		};
		return ps;
	};
	return {
		prepare: wrap,
		batch: async (stmts: Array<{ all: () => Promise<unknown> }>) =>
			Promise.all(stmts.map((s) => s.all())),
		exec: async (sql: string) => {
			db.exec(sql);
			return { count: 0, duration: 0 };
		},
		dump: async () => new ArrayBuffer(0),
	} as unknown as D1Database;
}

function realDb(): DbClient {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(REAL_DDL);
	return createDbClient(d1Facade(sqlite));
}

const ORG = "org-1";

type EventRow = typeof kernelRuntimeEventsTable.$inferSelect;

function makeEvent(overrides: Partial<EventRow> & { id: string }): EventRow {
	return {
		organizationId: ORG,
		kind: "message.received",
		conversationId: "home:chat",
		runId: null,
		messageId: null,
		delegatedTediId: null,
		childRunId: null,
		sequence: null,
		delta: null,
		payload: { channel: "home" },
		runtimeBackend: "custom",
		runtimeExternalId: null,
		runtimeExternalUrl: null,
		runtimeMetadata: null,
		traceId: null,
		createdAt: "2026-07-01T00:00:00.000Z",
		...overrides,
	} as EventRow;
}

async function seedProjectionRows(
	db: DbClient,
	rows: Array<
		Omit<typeof kernelConversations.$inferInsert, "id" | "updatedAt">
	>,
): Promise<void> {
	await db.insert(kernelConversations).values(
		rows.map((row) => ({
			...row,
			id: `${row.organizationId}:${row.conversationId}`,
			updatedAt: row.lastMessageAt,
		})),
	);
}

async function readProjection(
	db: DbClient,
	conversationId: string,
): Promise<KernelConversation | undefined> {
	const rows = await db.select().from(kernelConversations);
	return rows.find((row) => row.conversationId === conversationId);
}

describe("applyKernelConversationEvent (write-through)", () => {
	it("persists the server-validated Workspace and selected workpiece", async () => {
		const db = realDb();
		await applyKernelConversationEvent(
			db,
			makeEvent({
				id: "workspace-event",
				payload: {
					channel: "home",
					metadata: {
						workspaceContext: {
							workspaceId: "workspace-1",
							workpiece: { kind: "output", id: "output-1" },
						},
					},
				},
			}),
		);
		expect(await readProjection(db, "home:chat")).toMatchObject({
			workspaceId: "workspace-1",
			workpieceKind: "output",
			workpieceId: "output-1",
		});
	});

	it("creates a row on the first message and bumps count + recency on later ones", async () => {
		const db = realDb();
		await applyKernelConversationEvent(
			db,
			makeEvent({
				id: "e1",
				kind: "message.received",
				createdAt: "2026-07-01T00:00:00.000Z",
			}),
		);
		await applyKernelConversationEvent(
			db,
			makeEvent({
				id: "e2",
				kind: "message.completed",
				createdAt: "2026-07-01T00:01:00.000Z",
			}),
		);
		const row = await readProjection(db, "home:chat");
		expect(row).toMatchObject({
			organizationId: ORG,
			conversationId: "home:chat",
			channel: "home",
			messageCount: 2,
			lastMessageAt: "2026-07-01T00:01:00.000Z",
			// createdAt stays the first-seen event timestamp.
			createdAt: "2026-07-01T00:00:00.000Z",
			title: null,
			titleSource: null,
		});
	});

	it("never regresses recency on a backdated event but still counts it", async () => {
		const db = realDb();
		await applyKernelConversationEvent(
			db,
			makeEvent({ id: "e1", createdAt: "2026-07-01T00:05:00.000Z" }),
		);
		await applyKernelConversationEvent(
			db,
			makeEvent({ id: "e0", createdAt: "2026-07-01T00:01:00.000Z" }),
		);
		const row = await readProjection(db, "home:chat");
		expect(row?.lastMessageAt).toBe("2026-07-01T00:05:00.000Z");
		expect(row?.messageCount).toBe(2);
	});

	it("ignores kinds the projection does not track", async () => {
		const db = realDb();
		await applyKernelConversationEvent(
			db,
			makeEvent({ id: "e1", kind: "run.completed" }),
		);
		await applyKernelConversationEvent(
			db,
			makeEvent({ id: "e2", kind: "message.delta" }),
		);
		expect(await readProjection(db, "home:chat")).toBeUndefined();
	});

	it("rename always beats autoTitle, regardless of event order", async () => {
		const db = realDb();
		await applyKernelConversationEvent(
			db,
			makeEvent({
				id: "auto-1",
				kind: "conversation.updated",
				payload: {
					conversation: { title: "Auto title" },
					title: "Auto title",
					source: KERNEL_AUTO_TITLE_SOURCE,
				},
				createdAt: "2026-07-01T00:01:00.000Z",
			}),
		);
		let row = await readProjection(db, "home:chat");
		expect(row).toMatchObject({
			title: "Auto title",
			titleSource: "autoTitle",
		});

		await applyKernelConversationEvent(
			db,
			makeEvent({
				id: "rename-1",
				kind: "conversation.updated",
				payload: {
					conversation: { title: "Operator title" },
					title: "Operator title",
					source: "kernelRuntime.renameConversation",
				},
				createdAt: "2026-07-01T00:02:00.000Z",
			}),
		);
		row = await readProjection(db, "home:chat");
		expect(row).toMatchObject({
			title: "Operator title",
			titleSource: "rename",
		});

		// A LATE autoTitle (e.g. a lost race) must never shadow the human rename.
		await applyKernelConversationEvent(
			db,
			makeEvent({
				id: "auto-2",
				kind: "conversation.updated",
				payload: {
					conversation: { title: "Sneaky auto title" },
					title: "Sneaky auto title",
					source: KERNEL_AUTO_TITLE_SOURCE,
				},
				createdAt: "2026-07-01T00:03:00.000Z",
			}),
		);
		row = await readProjection(db, "home:chat");
		expect(row).toMatchObject({
			title: "Operator title",
			titleSource: "rename",
		});
	});

	it("a newer rename overwrites a previous rename and title events do not bump recency", async () => {
		const db = realDb();
		await applyKernelConversationEvent(
			db,
			makeEvent({ id: "m1", createdAt: "2026-07-01T00:00:00.000Z" }),
		);
		for (const [index, title] of ["First name", "Second name"].entries()) {
			await applyKernelConversationEvent(
				db,
				makeEvent({
					id: `rename-${index}`,
					kind: "conversation.updated",
					payload: {
						conversation: { title },
						title,
						source: "kernelRuntime.renameConversation",
					},
					createdAt: `2026-07-01T00:0${index + 1}:00.000Z`,
				}),
			);
		}
		const row = await readProjection(db, "home:chat");
		expect(row).toMatchObject({ title: "Second name", titleSource: "rename" });
		// Renames must not float the conversation to the top of the list.
		expect(row?.lastMessageAt).toBe("2026-07-01T00:00:00.000Z");
		expect(row?.messageCount).toBe(1);
	});

	it("soft-deletes via a deletedAt payload sibling to title, sticky across later events", async () => {
		const db = realDb();
		await applyKernelConversationEvent(
			db,
			makeEvent({
				id: "m1",
				kind: "message.received",
				createdAt: "2026-07-01T00:00:00.000Z",
			}),
		);
		await applyKernelConversationEvent(
			db,
			makeEvent({
				id: "delete-1",
				kind: "conversation.updated",
				payload: {
					conversation: { deletedAt: "2026-07-01T00:01:00.000Z" },
					deletedAt: "2026-07-01T00:01:00.000Z",
					source: "kernelRuntime.deleteConversation",
				},
				createdAt: "2026-07-01T00:01:00.000Z",
			}),
		);
		let row = await readProjection(db, "home:chat");
		expect(row?.deletedAt).toBe("2026-07-01T00:01:00.000Z");

		// A stray later event (e.g. a race with an in-flight message) must never
		// clear the soft-delete back to visible.
		await applyKernelConversationEvent(
			db,
			makeEvent({
				id: "m2",
				kind: "message.completed",
				createdAt: "2026-07-01T00:02:00.000Z",
			}),
		);
		row = await readProjection(db, "home:chat");
		expect(row?.deletedAt).toBe("2026-07-01T00:01:00.000Z");

		// A second delete call (idempotent from the caller's perspective) keeps
		// the ORIGINAL deletedAt rather than overwriting it with a later one.
		await applyKernelConversationEvent(
			db,
			makeEvent({
				id: "delete-2",
				kind: "conversation.updated",
				payload: {
					conversation: { deletedAt: "2026-07-01T00:05:00.000Z" },
					deletedAt: "2026-07-01T00:05:00.000Z",
					source: "kernelRuntime.deleteConversation",
				},
				createdAt: "2026-07-01T00:05:00.000Z",
			}),
		);
		row = await readProjection(db, "home:chat");
		expect(row?.deletedAt).toBe("2026-07-01T00:01:00.000Z");
	});

	it("pins via a pinned boolean payload and unpin clears it (not sticky, unlike delete)", async () => {
		const db = realDb();
		await applyKernelConversationEvent(
			db,
			makeEvent({
				id: "m1",
				kind: "message.received",
				createdAt: "2026-07-01T00:00:00.000Z",
			}),
		);
		await applyKernelConversationEvent(
			db,
			makeEvent({
				id: "pin-1",
				kind: "conversation.updated",
				payload: {
					conversation: { pinned: true },
					pinned: true,
					source: "kernelRuntime.pinConversation",
				},
				createdAt: "2026-07-01T00:01:00.000Z",
			}),
		);
		let row = await readProjection(db, "home:chat");
		expect(row?.pinnedAt).toBe("2026-07-01T00:01:00.000Z");
		// A pin event must not bump recency or clobber the message count.
		expect(row?.messageCount).toBe(1);
		expect(row?.lastMessageAt).toBe("2026-07-01T00:00:00.000Z");

		// Unpin (pinned: false) CLEARS the marker back to null — unlike the sticky
		// deletedAt, pins are toggleable.
		await applyKernelConversationEvent(
			db,
			makeEvent({
				id: "unpin-1",
				kind: "conversation.updated",
				payload: {
					conversation: { pinned: false },
					pinned: false,
					source: "kernelRuntime.pinConversation",
				},
				createdAt: "2026-07-01T00:02:00.000Z",
			}),
		);
		row = await readProjection(db, "home:chat");
		expect(row?.pinnedAt).toBeNull();
	});

	it("archives via a clearable marker and includes archived rows only on request", async () => {
		const db = realDb();
		await applyKernelConversationEvent(
			db,
			makeEvent({ id: "m1", kind: "message.received" }),
		);
		await applyKernelConversationEvent(
			db,
			makeEvent({
				id: "archive-1",
				kind: "conversation.updated",
				payload: {
					conversation: { archived: true },
					archived: true,
					source: "kernelRuntime.archiveConversation",
				},
				createdAt: "2026-07-01T00:01:00.000Z",
			}),
		);
		expect((await readProjection(db, "home:chat"))?.archivedAt).toBe(
			"2026-07-01T00:01:00.000Z",
		);
		expect(
			await selectKernelConversationIndexPage(db, {
				organizationId: ORG,
				cursor: null,
				limit: 10,
			}),
		).toEqual([]);
		expect(
			await selectKernelConversationIndexPage(db, {
				organizationId: ORG,
				cursor: null,
				limit: 10,
				includeArchived: true,
			}),
		).toHaveLength(1);

		await applyKernelConversationEvent(
			db,
			makeEvent({
				id: "restore-1",
				kind: "conversation.updated",
				payload: {
					conversation: { archived: false },
					archived: false,
					source: "kernelRuntime.archiveConversation",
				},
				createdAt: "2026-07-01T00:02:00.000Z",
			}),
		);
		expect((await readProjection(db, "home:chat"))?.archivedAt).toBeNull();
	});

	it("is fail-soft when the projection table is missing", async () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec(
			"CREATE TABLE kernel_runtime_events (id TEXT PRIMARY KEY NOT NULL);",
		);
		const db = createDbClient(d1Facade(sqlite));
		await expect(
			applyKernelConversationEvent(db, makeEvent({ id: "e1" })),
		).resolves.toBeUndefined();
	});
});

describe("conversation origin (write-through)", () => {
	function userMessage(
		id: string,
		origin: "human" | "agent" | undefined,
		overrides: Partial<EventRow> = {},
	): EventRow {
		return makeEvent({
			id,
			kind: "message.received",
			payload: {
				role: "user",
				content: "Count the tedis",
				channel: "home",
				...(origin ? { origin } : {}),
			},
			...overrides,
		});
	}

	it("stamps agent on a conversation an agent turn created", async () => {
		const db = realDb();
		await applyKernelConversationEvent(db, userMessage("e1", "agent"));
		expect((await readProjection(db, "home:chat"))?.origin).toBe("agent");
	});

	it("stamps human on a conversation an operator turn created", async () => {
		const db = realDb();
		await applyKernelConversationEvent(db, userMessage("e1", "human"));
		expect((await readProjection(db, "home:chat"))?.origin).toBe("human");
	});

	/**
	 * The load-bearing case. Every row that existed before this column was
	 * added is NULL and nothing was backfilled, so NULL must resolve to the
	 * operator's own traffic — a projection that emitted "agent" here would
	 * empty the sidebar the moment anything filters on origin.
	 */
	it("leaves an unstamped event's row NULL, which reads as human", async () => {
		const db = realDb();
		await applyKernelConversationEvent(db, userMessage("e1", undefined));
		const row = await readProjection(db, "home:chat");
		expect(row?.origin).toBeNull();
		expect(kernelConversationOriginOrHuman(row?.origin)).toBe("human");
	});

	it("keeps the agent stamp across the conversation's later agent turns", async () => {
		const db = realDb();
		await applyKernelConversationEvent(db, userMessage("e1", "agent"));
		await applyKernelConversationEvent(
			db,
			userMessage("e2", "agent", { createdAt: "2026-07-01T00:01:00.000Z" }),
		);
		const row = await readProjection(db, "home:chat");
		expect(row?.origin).toBe("agent");
		expect(row?.messageCount).toBe(2);
	});

	it("reclaims an agent-created conversation for the human who replies in it", async () => {
		const db = realDb();
		await applyKernelConversationEvent(db, userMessage("e1", "agent"));
		await applyKernelConversationEvent(
			db,
			userMessage("e2", "human", { createdAt: "2026-07-01T00:01:00.000Z" }),
		);
		expect((await readProjection(db, "home:chat"))?.origin).toBe("human");
	});

	it("never reclassifies a conversation that already has unstamped history", async () => {
		const db = realDb();
		// A pre-column row: real messages, no stamp.
		await applyKernelConversationEvent(db, userMessage("e1", undefined));
		await applyKernelConversationEvent(
			db,
			userMessage("e2", "agent", { createdAt: "2026-07-01T00:01:00.000Z" }),
		);
		const row = await readProjection(db, "home:chat");
		expect(row?.origin).toBeNull();
		expect(kernelConversationOriginOrHuman(row?.origin)).toBe("human");
	});

	it("does not let an unstamped assistant completion clear the agent stamp", async () => {
		const db = realDb();
		await applyKernelConversationEvent(db, userMessage("e1", "agent"));
		await applyKernelConversationEvent(
			db,
			makeEvent({
				id: "e2",
				kind: "message.completed",
				createdAt: "2026-07-01T00:01:00.000Z",
				payload: { role: "assistant", channel: "home" },
			}),
		);
		expect((await readProjection(db, "home:chat"))?.origin).toBe("agent");
	});

	it("stamps a row an earlier non-message event seeded", async () => {
		const db = realDb();
		// A pin/rename/delete event creates the row with message_count 0; the
		// first real turn still gets to classify it.
		await applyKernelConversationEvent(
			db,
			makeEvent({
				id: "pin-1",
				kind: "conversation.updated",
				payload: { pinned: true },
			}),
		);
		await applyKernelConversationEvent(
			db,
			userMessage("e1", "agent", { createdAt: "2026-07-01T00:01:00.000Z" }),
		);
		expect((await readProjection(db, "home:chat"))?.origin).toBe("agent");
	});
});

describe("provisional first-message title (write-through)", () => {
	function userMessage(
		overrides: Partial<EventRow> & { id: string },
	): EventRow {
		return makeEvent({
			kind: "message.received",
			payload: {
				role: "user",
				content: "How do invoices sync to globex? Please check the connector.",
				channel: "home",
			},
			...overrides,
		});
	}

	it("stamps a provisional title from the FIRST user message only", async () => {
		const db = realDb();
		await applyKernelConversationEvent(
			db,
			userMessage({ id: "m1", createdAt: "2026-07-01T00:00:00.000Z" }),
		);
		let row = await readProjection(db, "home:chat");
		expect(row).toMatchObject({
			title: "How do invoices sync to globex",
			titleSource: "provisional",
			messageCount: 1,
		});

		// A later user message must never re-title the conversation.
		await applyKernelConversationEvent(
			db,
			userMessage({
				id: "m2",
				payload: {
					role: "user",
					content: "Different topic now",
					channel: "home",
				},
				createdAt: "2026-07-01T00:01:00.000Z",
			}),
		);
		row = await readProjection(db, "home:chat");
		expect(row).toMatchObject({
			title: "How do invoices sync to globex",
			titleSource: "provisional",
			messageCount: 2,
		});
	});

	it("takes the provisional title on the conflict path for a pre-created untitled row", async () => {
		const db = realDb();
		// Row created by a pin event (messageCount 0, no title) — the first user
		// message still labels it via the guarded conflict CASE.
		await applyKernelConversationEvent(
			db,
			makeEvent({
				id: "pin-1",
				kind: "conversation.updated",
				payload: {
					conversation: { pinned: true },
					pinned: true,
					source: "kernelRuntime.pinConversation",
				},
				createdAt: "2026-07-01T00:00:00.000Z",
			}),
		);
		await applyKernelConversationEvent(
			db,
			userMessage({ id: "m1", createdAt: "2026-07-01T00:01:00.000Z" }),
		);
		const row = await readProjection(db, "home:chat");
		expect(row).toMatchObject({
			title: "How do invoices sync to globex",
			titleSource: "provisional",
			messageCount: 1,
		});
	});

	it("never titles assistant settlements or role-less messages", async () => {
		const db = realDb();
		await applyKernelConversationEvent(
			db,
			makeEvent({
				id: "m1",
				kind: "message.completed",
				payload: {
					role: "assistant",
					content: "Here is my answer",
					channel: "home",
				},
				createdAt: "2026-07-01T00:00:00.000Z",
			}),
		);
		await applyKernelConversationEvent(
			db,
			makeEvent({
				id: "m2",
				kind: "message.received",
				payload: { channel: "home" },
				createdAt: "2026-07-01T00:01:00.000Z",
			}),
		);
		const row = await readProjection(db, "home:chat");
		expect(row).toMatchObject({ title: null, titleSource: null });
	});

	it("never titles the org main thread or ephemeral smoke conversations", async () => {
		const db = realDb();
		await applyKernelConversationEvent(
			db,
			userMessage({
				id: "m1",
				conversationId: "home:main",
				createdAt: "2026-07-01T00:00:00.000Z",
			}),
		);
		await applyKernelConversationEvent(
			db,
			userMessage({
				id: "m2",
				conversationId: "home:kernel-steering:1751328000000",
				createdAt: "2026-07-01T00:00:00.000Z",
			}),
		);
		expect(await readProjection(db, "home:main")).toMatchObject({
			title: null,
			titleSource: null,
		});
		expect(
			await readProjection(db, "home:kernel-steering:1751328000000"),
		).toMatchObject({
			title: null,
			titleSource: null,
		});
	});

	it("auto-title overwrites provisional; rename beats both; provisional never clobbers either", async () => {
		const db = realDb();
		await applyKernelConversationEvent(
			db,
			userMessage({ id: "m1", createdAt: "2026-07-01T00:00:00.000Z" }),
		);
		expect(await readProjection(db, "home:chat")).toMatchObject({
			titleSource: "provisional",
		});

		// The post-settle auto-title upgrades the provisional placeholder.
		await applyKernelConversationEvent(
			db,
			makeEvent({
				id: "auto-1",
				kind: "conversation.updated",
				payload: {
					conversation: { title: "Globex Invoice Sync" },
					title: "Globex Invoice Sync",
					source: KERNEL_AUTO_TITLE_SOURCE,
				},
				createdAt: "2026-07-01T00:01:00.000Z",
			}),
		);
		expect(await readProjection(db, "home:chat")).toMatchObject({
			title: "Globex Invoice Sync",
			titleSource: "autoTitle",
		});

		// An operator rename beats the auto title …
		await applyKernelConversationEvent(
			db,
			makeEvent({
				id: "rename-1",
				kind: "conversation.updated",
				payload: {
					conversation: { title: "Q3 invoicing" },
					title: "Q3 invoicing",
					source: "kernelRuntime.renameConversation",
				},
				createdAt: "2026-07-01T00:02:00.000Z",
			}),
		);
		expect(await readProjection(db, "home:chat")).toMatchObject({
			title: "Q3 invoicing",
			titleSource: "rename",
		});

		// … and a late user message can never demote it back to provisional.
		await applyKernelConversationEvent(
			db,
			userMessage({
				id: "m2",
				payload: {
					role: "user",
					content: "Unrelated follow-up",
					channel: "home",
				},
				createdAt: "2026-07-01T00:03:00.000Z",
			}),
		);
		expect(await readProjection(db, "home:chat")).toMatchObject({
			title: "Q3 invoicing",
			titleSource: "rename",
		});
	});

	it("renamed-before-first-message rows keep the rename", async () => {
		const db = realDb();
		await applyKernelConversationEvent(
			db,
			makeEvent({
				id: "rename-1",
				kind: "conversation.updated",
				payload: {
					conversation: { title: "Prepared thread" },
					title: "Prepared thread",
					source: "kernelRuntime.renameConversation",
				},
				createdAt: "2026-07-01T00:00:00.000Z",
			}),
		);
		await applyKernelConversationEvent(
			db,
			userMessage({ id: "m1", createdAt: "2026-07-01T00:01:00.000Z" }),
		);
		expect(await readProjection(db, "home:chat")).toMatchObject({
			title: "Prepared thread",
			titleSource: "rename",
		});
	});
});

describe("conversation index page reads", () => {
	it("paginates with the (last_message_at, conversation_id) keyset cursor", async () => {
		const db = realDb();
		await seedProjectionRows(db, [
			{
				organizationId: ORG,
				conversationId: "home:c",
				title: null,
				titleSource: null,
				channel: null,
				lastMessageAt: "2026-07-01T09:00:00.000Z",
				messageCount: 1,
				createdAt: "2026-07-01T09:00:00.000Z",
			},
			// home:a and home:b share last_message_at — the id tiebreak keeps the
			// page split stable.
			{
				organizationId: ORG,
				conversationId: "home:b",
				title: null,
				titleSource: null,
				channel: null,
				lastMessageAt: "2026-07-01T08:00:00.000Z",
				messageCount: 1,
				createdAt: "2026-07-01T08:00:00.000Z",
			},
			{
				organizationId: ORG,
				conversationId: "home:a",
				title: null,
				titleSource: null,
				channel: null,
				lastMessageAt: "2026-07-01T08:00:00.000Z",
				messageCount: 1,
				createdAt: "2026-07-01T08:00:00.000Z",
			},
		]);

		const firstPage = await selectKernelConversationIndexPage(db, {
			organizationId: ORG,
			cursor: null,
			limit: 2,
		});
		expect(firstPage.map((row) => row.conversationId)).toEqual([
			"home:c",
			"home:b",
		]);
		const cursor = encodeKernelConversationCursor(
			firstPage[firstPage.length - 1],
		);
		expect(cursor).toBe("2026-07-01T08:00:00.000Z|home:b");

		const secondPage = await selectKernelConversationIndexPage(db, {
			organizationId: ORG,
			cursor: parseKernelConversationCursor(cursor),
			limit: 2,
		});
		expect(secondPage.map((row) => row.conversationId)).toEqual(["home:a"]);
	});

	it("rejects timestamp-only and incomplete cursors", () => {
		expect(() =>
			parseKernelConversationCursor("2026-07-01T08:00:00.000Z"),
		).toThrow("Invalid conversation cursor");
		expect(() =>
			parseKernelConversationCursor("2026-07-01T08:00:00.000Z|"),
		).toThrow("Invalid conversation cursor");
	});

	it("excludes a soft-deleted conversation from the page", async () => {
		const db = realDb();
		await seedProjectionRows(db, [
			{
				organizationId: ORG,
				conversationId: "home:visible",
				title: null,
				titleSource: null,
				channel: null,
				lastMessageAt: "2026-07-01T09:00:00.000Z",
				messageCount: 1,
				createdAt: "2026-07-01T09:00:00.000Z",
			},
			{
				organizationId: ORG,
				conversationId: "home:deleted",
				title: null,
				titleSource: null,
				channel: null,
				lastMessageAt: "2026-07-01T10:00:00.000Z",
				messageCount: 1,
				deletedAt: "2026-07-01T10:05:00.000Z",
				createdAt: "2026-07-01T10:00:00.000Z",
			},
		]);
		const page = await selectKernelConversationIndexPage(db, {
			organizationId: ORG,
			cursor: null,
			limit: 10,
		});
		expect(page.map((row) => row.conversationId)).toEqual(["home:visible"]);
	});

	it("round-trips cursors even when the conversation id contains the separator", () => {
		const cursor = encodeKernelConversationCursor({
			lastMessageAt: "2026-07-01T08:00:00.000Z",
			conversationId: "home|weird|id",
		});
		expect(parseKernelConversationCursor(cursor)).toEqual({
			lastMessageAt: "2026-07-01T08:00:00.000Z",
			conversationId: "home|weird|id",
		});
	});

	it("scopes pages to the requested org", async () => {
		const db = realDb();
		await seedProjectionRows(db, [
			{
				organizationId: ORG,
				conversationId: "home:mine",
				title: null,
				titleSource: null,
				channel: null,
				lastMessageAt: "2026-07-01T09:00:00.000Z",
				messageCount: 1,
				createdAt: "2026-07-01T09:00:00.000Z",
			},
			{
				organizationId: "org-2",
				conversationId: "home:theirs",
				title: null,
				titleSource: null,
				channel: null,
				lastMessageAt: "2026-07-01T09:30:00.000Z",
				messageCount: 1,
				createdAt: "2026-07-01T09:30:00.000Z",
			},
		]);
		const page = await selectKernelConversationIndexPage(db, {
			organizationId: ORG,
			cursor: null,
			limit: 10,
		});
		expect(page.map((row) => row.conversationId)).toEqual(["home:mine"]);
	});
});
