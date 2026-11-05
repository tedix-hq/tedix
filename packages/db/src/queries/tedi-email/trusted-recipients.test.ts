import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import {
	addTediEmailTrustedRecipient,
	buildListActiveTediEmailTrustedRecipientsStatement,
	listTediEmailTrustedRecipients,
	revokeTediEmailTrustedRecipient,
} from "./trusted-recipients";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE tedi_email_trusted_recipients (
			id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, tedi_id TEXT NOT NULL,
			address TEXT NOT NULL, created_by TEXT NOT NULL,
			created_at TEXT DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
			revoked_at TEXT, revoked_by TEXT
		);
		CREATE UNIQUE INDEX uniq_tedi_email_trusted_recipient_active
			ON tedi_email_trusted_recipients (tedi_id, address) WHERE revoked_at IS NULL;
	`);
	return { db: createDbQueryClient(createD1Facade(sqlite)) };
}

const scope = { organizationId: "org-1", tediId: "tedi-1" };

describe("tedi email trusted recipients", () => {
	it("adds idempotently through one batch and lists only the owning tedi", async () => {
		const { db } = fixture();
		const first = await addTediEmailTrustedRecipient(db, {
			...scope,
			address: "partner@example.com",
			createdBy: "user:u1",
		});
		const again = await addTediEmailTrustedRecipient(db, {
			...scope,
			address: "partner@example.com",
			createdBy: "user:u2",
		});
		expect(first.created).toBe(true);
		expect(again).toMatchObject({
			created: false,
			recipient: { id: first.recipient.id, createdBy: "user:u1" },
		});
		await addTediEmailTrustedRecipient(db, {
			organizationId: "org-1",
			tediId: "tedi-2",
			address: "other@example.com",
			createdBy: "user:u1",
		});
		const listed = await listTediEmailTrustedRecipients(db, scope);
		expect(listed.map((row) => row.address)).toEqual(["partner@example.com"]);
		await expect(
			listTediEmailTrustedRecipients(db, { ...scope, organizationId: "org-9" }),
		).resolves.toEqual([]);
	});

	it("revokes only inside scope and allows the address to be added again", async () => {
		const { db } = fixture();
		const { recipient } = await addTediEmailTrustedRecipient(db, {
			...scope,
			address: "partner@example.com",
			createdBy: "user:u1",
		});
		await expect(
			revokeTediEmailTrustedRecipient(db, {
				...scope,
				organizationId: "org-9",
				id: recipient.id,
				revokedBy: "user:u1",
			}),
		).resolves.toBeNull();
		const revoked = await revokeTediEmailTrustedRecipient(db, {
			...scope,
			id: recipient.id,
			revokedBy: "user:u1",
		});
		expect(revoked).toMatchObject({ id: recipient.id, revokedBy: "user:u1" });
		expect(revoked?.revokedAt).toBeTruthy();
		await expect(
			revokeTediEmailTrustedRecipient(db, {
				...scope,
				id: recipient.id,
				revokedBy: "user:u1",
			}),
		).resolves.toBeNull();
		await expect(listTediEmailTrustedRecipients(db, scope)).resolves.toEqual(
			[],
		);
		const readded = await addTediEmailTrustedRecipient(db, {
			...scope,
			address: "partner@example.com",
			createdBy: "user:u1",
		});
		expect(readded.created).toBe(true);
		const history = await listTediEmailTrustedRecipients(db, {
			...scope,
			includeRevoked: true,
		});
		expect(history).toHaveLength(2);
	});

	it("composes the active-list read into a D1 batch", async () => {
		const { db } = fixture();
		await addTediEmailTrustedRecipient(db, {
			...scope,
			address: "partner@example.com",
			createdBy: "user:u1",
		});
		const [mine, theirs] = await db.batch([
			buildListActiveTediEmailTrustedRecipientsStatement(db, scope),
			buildListActiveTediEmailTrustedRecipientsStatement(db, {
				...scope,
				tediId: "tedi-2",
			}),
		]);
		expect(mine.map((row) => row.address)).toEqual(["partner@example.com"]);
		expect(theirs).toEqual([]);
	});
});
