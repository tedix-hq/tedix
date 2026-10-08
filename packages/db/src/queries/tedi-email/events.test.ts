import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import { createD1Facade } from "../../test/d1-facade";
import { recordTediEmailOutcome } from "./events";
import {
	countRecentInboundTediEmailMessages,
	findUniqueInboundTediEmailMessageIdentityByHeader,
	getInboundTediEmailMessageIdentity,
} from "./messages";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE tedi_email_messages (
			id TEXT PRIMARY KEY, thread_id TEXT NOT NULL,
			organization_id TEXT NOT NULL, tedi_id TEXT NOT NULL,
			direction TEXT NOT NULL, message_id_header TEXT,
			from_addr TEXT NOT NULL DEFAULT 'sender@example.com',
			received_at TEXT
		);
		CREATE TABLE tedi_email_events (
			id TEXT PRIMARY KEY, message_id TEXT, thread_id TEXT,
			organization_id TEXT NOT NULL, tedi_id TEXT NOT NULL,
			event_type TEXT NOT NULL, provider TEXT, payload_json TEXT,
			created_at TEXT DEFAULT CURRENT_TIMESTAMP
		);
	`);
	const insert = sqlite.prepare(`
		INSERT INTO tedi_email_messages
		(id, thread_id, organization_id, tedi_id, direction, message_id_header)
		VALUES (?, ?, ?, ?, ?, ?)
	`);
	return {
		sqlite,
		db: createDbClient(createD1Facade(sqlite)),
		insert: (
			id: string,
			org: string,
			tedi: string,
			header: string,
			direction = "inbound",
		) => insert.run(id, `thread-${id}`, org, tedi, direction, header),
	};
}

describe("content-free email outcome receipts", () => {
	it("requires an inbound identity and exact tenant-scoped RFC Message-ID", async () => {
		const { db, insert } = fixture();
		insert("a", "org-1", "tedi-1", "<same@example.org>");
		insert("b", "org-2", "tedi-2", "<same@example.org>");
		insert("c", "org-1", "tedi-1", "<sent@example.org>", "outbound");
		expect(await getInboundTediEmailMessageIdentity(db, "a")).toMatchObject({
			id: "a",
			organizationId: "org-1",
		});
		await expect(
			getInboundTediEmailMessageIdentity(db, "c"),
		).resolves.toBeNull();
		await expect(
			findUniqueInboundTediEmailMessageIdentityByHeader(db, {
				tediId: "tedi-1",
				organizationId: "org-1",
				messageIdHeader: "<same@example.org>",
			}),
		).resolves.toMatchObject({ status: "found", message: { id: "a" } });
		await expect(
			findUniqueInboundTediEmailMessageIdentityByHeader(db, {
				tediId: "tedi-1",
				organizationId: "org-1",
				messageIdHeader: "same@example.org",
			}),
		).resolves.toEqual({ status: "missing" });
		insert("d", "org-1", "tedi-1", "<same@example.org>");
		await expect(
			findUniqueInboundTediEmailMessageIdentityByHeader(db, {
				tediId: "tedi-1",
				organizationId: "org-1",
				messageIdHeader: "<same@example.org>",
			}),
		).resolves.toEqual({ status: "ambiguous" });
	});

	it("idempotently records identical observations and rejects contradictory retries", async () => {
		const { db, sqlite } = fixture();
		const message = {
			id: "message-1",
			threadId: "thread-1",
			tediId: "tedi-1",
			organizationId: "org-1",
		};
		const input = {
			kind: "runtime_turn" as const,
			message,
			runId: "run-1",
			result: "completed" as const,
			elapsedMs: 123,
			replied: false,
		};
		const first = await recordTediEmailOutcome(db, input);
		const repeated = await recordTediEmailOutcome(db, input);
		expect(first.duplicate).toBe(false);
		expect(repeated).toEqual({ id: first.id, duplicate: true });
		await expect(
			recordTediEmailOutcome(db, { ...input, replied: true }),
		).rejects.toThrow("Conflicting email outcome observation");
		const rows = sqlite
			.prepare("SELECT * FROM tedi_email_events")
			.all() as Array<{
			payload_json: string;
			event_type: string;
		}>;
		expect(rows).toHaveLength(1);
		expect(rows[0]?.event_type).toBe("runtime_turn_outcome");
		expect(JSON.parse(rows[0]!.payload_json)).toEqual({
			runId: "run-1",
			elapsedMs: 123,
			result: "completed",
			replied: false,
		});
	});

	it("attributes dispatch observations to email ingress", async () => {
		const { db, sqlite } = fixture();
		await recordTediEmailOutcome(db, {
			kind: "worker_dispatch",
			message: {
				id: "message-1",
				threadId: "thread-1",
				tediId: "tedi-1",
				organizationId: "org-1",
			},
			result: "sdk_returned",
			elapsedMs: 42,
		});
		const row = sqlite
			.prepare("SELECT provider FROM tedi_email_events")
			.get() as { provider: string };
		expect(row.provider).toBe("email-ingress");
	});
});

describe("recent inbound volume for sender rate limiting", () => {
	it("counts one tedi's inbound mail inside the window, minus excluded senders", async () => {
		const { db, sqlite } = fixture();
		const insert = sqlite.prepare(`
			INSERT INTO tedi_email_messages
			(id, thread_id, organization_id, tedi_id, direction, from_addr, received_at)
			VALUES (?, ?, 'org-1', ?, ?, ?, ?)
		`);
		const now = Date.now();
		const at = (minutesAgo: number) =>
			new Date(now - minutesAgo * 60_000).toISOString();
		insert.run("a", "t-a", "tedi-1", "inbound", "x@spam.example", at(1));
		insert.run("b", "t-b", "tedi-1", "inbound", "y@spam.example", at(5));
		insert.run("c", "t-c", "tedi-1", "inbound", "ada@example.com", at(2));
		insert.run("d", "t-d", "tedi-1", "inbound", "z@spam.example", at(30));
		insert.run("e", "t-e", "tedi-1", "outbound", "tedi@tedix.tech", at(1));
		insert.run("f", "t-f", "tedi-2", "inbound", "x@spam.example", at(1));
		const sinceIso = at(10);
		await expect(
			countRecentInboundTediEmailMessages(db, {
				tediId: "tedi-1",
				organizationId: "org-1",
				sinceIso,
			}),
		).resolves.toBe(3);
		await expect(
			countRecentInboundTediEmailMessages(db, {
				tediId: "tedi-1",
				organizationId: "org-1",
				sinceIso,
				excludeFromAddrs: ["ada@example.com"],
			}),
		).resolves.toBe(2);
	});
});
