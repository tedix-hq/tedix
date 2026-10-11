import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import {
	tediEmailAttachments,
	tediEmailMessages,
	tediEmailThreads,
} from "../../schema/tedi-email";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { listTediEmailThreads, searchTediEmail } from "./threads";

const SCOPE = { tediId: "tedi-1", organizationId: "org-1" };

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(
		schemaDdl(tediEmailThreads, tediEmailMessages, tediEmailAttachments),
	);
	const insertThread = sqlite.prepare(
		`INSERT INTO tedi_email_threads (id, organization_id, tedi_id, subject_norm, participants_json, last_message_at)
		 VALUES (?, 'org-1', 'tedi-1', ?, '[]', ?)`,
	);
	const insertMessage = sqlite.prepare(
		`INSERT INTO tedi_email_messages (id, thread_id, organization_id, tedi_id, direction, from_addr, to_json, subject, text_body, status, created_at)
		 VALUES (?, ?, 'org-1', 'tedi-1', 'inbound', 'ada@example.com', '[]', ?, ?, 'received', ?)`,
	);
	return {
		db: createDbClient(createD1Facade(sqlite)),
		insert: (id: string, subject: string, body: string) => {
			const at = `2026-10-0${id.length}T00:00:00Z`;
			insertThread.run(id, subject.toLowerCase(), at);
			insertMessage.run(`m-${id}`, id, subject, body, at);
		},
	};
}

// The LIKEs these replaced turned any 48+ character search (a pasted subject
// line) into a D1_ERROR.
describe("tedi email search beyond D1's 50-byte LIKE pattern cap", () => {
	it("lists threads by a long subject query", async () => {
		const { db, insert } = fixture();
		const subject =
			"Re: Quarterly reconciliation of the Northwind receivables ledger for Fabrikam";
		insert("a", subject, "body");
		insert("bb", "Re: Quarterly reconciliation", "body");

		const page = await listTediEmailThreads(db, {
			...SCOPE,
			query: subject.toUpperCase(),
		});
		expect(page.threads.map((thread) => thread.id)).toEqual(["a"]);
	});

	it("searches messages by a long body query", async () => {
		const { db, insert } = fixture();
		const body =
			"Please confirm the fourteen outstanding invoices before Friday's close";
		insert("a", "hello", body);
		insert("bb", "hello", "Please confirm");

		const hits = await searchTediEmail(db, {
			...SCOPE,
			query: body.toUpperCase(),
		});
		expect(hits.map((hit) => hit.message.id)).toEqual(["m-a"]);
	});
});
