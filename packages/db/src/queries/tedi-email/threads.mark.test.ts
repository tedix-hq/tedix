import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import {
	tediEmailEvents,
	tediEmailMessages,
	tediEmailThreads,
} from "../../schema/tedi-email";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { markTediEmail } from "./threads";

const SCOPE = { tediId: "tedi-1", organizationId: "org-1" };

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(schemaDdl(tediEmailThreads, tediEmailMessages, tediEmailEvents));
	const insertThread = sqlite.prepare(
		`INSERT INTO tedi_email_threads
		 (id, organization_id, tedi_id, subject_norm, last_message_at, unread_count, updated_at)
		 VALUES (?, ?, ?, 'hello', '2026-10-23T12:00:00Z', 2, 'unchanged')`,
	);
	const insertMessage = sqlite.prepare(
		`INSERT INTO tedi_email_messages
		 (id, thread_id, organization_id, tedi_id, direction, from_addr, to_json, subject, status, updated_at)
		 VALUES (?, ?, ?, ?, 'inbound', 'ada@example.com', '[]', 'hello', 'received', 'unchanged')`,
	);
	for (const [id, org, tedi] of [
		["own", "org-1", "tedi-1"],
		["other-thread", "org-1", "tedi-1"],
		["other-tedi", "org-1", "tedi-2"],
		["other-org", "org-2", "tedi-1"],
	]) {
		insertThread.run(id, org, tedi);
		insertMessage.run(`${id}-1`, id, org, tedi);
		insertMessage.run(`${id}-2`, id, org, tedi);
	}
	return {
		db: createDbClient(createD1Facade(sqlite)),
		sqlite,
		snapshot: () => ({
			threads: sqlite
				.prepare("SELECT * FROM tedi_email_threads ORDER BY id")
				.all(),
			messages: sqlite
				.prepare("SELECT * FROM tedi_email_messages ORDER BY id")
				.all(),
			events: sqlite
				.prepare("SELECT * FROM tedi_email_events ORDER BY id")
				.all(),
		}),
	};
}

describe("mailbox-scoped email marking", () => {
	it.each([
		{ threadId: "other-tedi" },
		{ threadId: "other-org" },
		{ threadId: "missing" },
		{ messageId: "other-tedi-1" },
		{ messageId: "other-org-1" },
		{ messageId: "missing" },
		{ threadId: "own", messageId: "other-thread-1" },
		{ threadId: "own", messageId: "other-tedi-1" },
		{ threadId: "own", messageId: "missing" },
		{ threadId: "other-org", messageId: "own-1" },
		{},
	])(
		"rejects an inaccessible or inconsistent target %j before writes",
		async (target) => {
			const { db, snapshot } = fixture();
			const before = snapshot();
			await expect(
				markTediEmail(db, { ...SCOPE, ...target, read: true, archived: true }),
			).rejects.toThrow("Email message or thread not found");
			expect(snapshot()).toEqual(before);
		},
	);

	it("marks a whole owned thread and leaves other mailboxes unchanged", async () => {
		const { db, sqlite, snapshot } = fixture();
		const before = snapshot();
		expect(
			await markTediEmail(db, {
				...SCOPE,
				threadId: "own",
				read: true,
				archived: true,
			}),
		).toEqual({
			ok: true,
			threadId: "own",
			unreadCount: 0,
		});
		expect(
			sqlite
				.prepare(
					"SELECT status, unread_count FROM tedi_email_threads WHERE id = 'own'",
				)
				.get(),
		).toEqual({
			status: "archived",
			unread_count: 0,
		});
		const after = snapshot();
		expect(after.threads.filter((row) => row.id !== "own")).toEqual(
			before.threads.filter((row) => row.id !== "own"),
		);
		expect(after.messages.filter((row) => row.thread_id !== "own")).toEqual(
			before.messages.filter((row) => row.thread_id !== "own"),
		);
		expect(after.events).toHaveLength(1);
		expect(after.events[0]).toMatchObject({
			tedi_id: "tedi-1",
			organization_id: "org-1",
			thread_id: "own",
			event_type: "marked",
		});
	});

	it("resolves a message's thread and supports read and unread marking", async () => {
		const { db, sqlite } = fixture();
		expect(
			await markTediEmail(db, { ...SCOPE, messageId: "own-1", read: true }),
		).toEqual({ ok: true, threadId: "own", unreadCount: 1 });
		expect(
			sqlite
				.prepare("SELECT read_at FROM tedi_email_messages WHERE id = 'own-2'")
				.get(),
		).toEqual({ read_at: null });
		expect(
			await markTediEmail(db, {
				...SCOPE,
				threadId: "own",
				messageId: "own-1",
				read: false,
			}),
		).toEqual({ ok: true, threadId: "own", unreadCount: 2 });
	});

	it("does not include foreign mailbox messages in the unread aggregate", async () => {
		const { db, sqlite } = fixture();
		// Model a legacy inconsistent link; thread IDs alone cannot establish mailbox ownership.
		sqlite.exec(
			"UPDATE tedi_email_messages SET thread_id = 'own' WHERE id = 'other-tedi-1'",
		);
		expect(
			await markTediEmail(db, { ...SCOPE, threadId: "own", spam: true }),
		).toEqual({ ok: true, threadId: "own", unreadCount: 2 });
		expect(
			sqlite
				.prepare(
					"SELECT updated_at FROM tedi_email_messages WHERE id = 'other-tedi-1'",
				)
				.get(),
		).toEqual({ updated_at: "unchanged" });
	});
});
