import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import {
	tediEmailAttachments,
	tediEmailEvents,
	tediEmailMessages,
	tediEmailThreads,
} from "../../schema/tedi-email";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { ingestInboundTediEmail } from "./delivery";
import { getTediEmailThread } from "./threads";

const SCOPE = { tediId: "tedi-1", organizationId: "org-1" };
const ROOT = "<root@acme.example>";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(
		schemaDdl(
			tediEmailThreads,
			tediEmailMessages,
			tediEmailAttachments,
			tediEmailEvents,
		),
	);
	return createDbClient(createD1Facade(sqlite));
}

function mail(senderTrust: "trusted" | "untrusted", from: string) {
	return {
		...SCOPE,
		to: "acme@tedix.tech",
		from,
		subject: "Re: Invoice 42",
		textBody: "body",
		senderTrust,
		inReplyTo: ROOT,
		references: [ROOT],
	};
}

// In-Reply-To, References and the subject are written by the sender. A
// stranger naming a verified correspondent's thread must get a thread of its
// own, marked unverified, while the correspondent's own replies still join.
describe("inbound thread selection by sender trust", () => {
	it("keeps an unverified sender out of a trusted thread it names", async () => {
		const db = fixture();
		const trusted = await ingestInboundTediEmail(db, {
			...mail("trusted", "ana@acme.example"),
			messageIdHeader: ROOT,
			inReplyTo: null,
			references: [],
		});
		expect(trusted.thread.senderTrust).toBe("trusted");

		const forged = await ingestInboundTediEmail(db, {
			...mail("untrusted", "stranger@example.net"),
			messageIdHeader: "<forged@example.net>",
		});
		expect(forged.thread.id).not.toBe(trusted.thread.id);
		expect(forged.thread.senderTrust).toBe("untrusted");
		expect(forged.message.threadId).toBe(forged.thread.id);

		const reply = await ingestInboundTediEmail(db, {
			...mail("trusted", "ana@acme.example"),
			messageIdHeader: "<reply@acme.example>",
		});
		expect(reply.thread.id).toBe(trusted.thread.id);

		const again = await ingestInboundTediEmail(db, {
			...mail("untrusted", "stranger@example.net"),
			messageIdHeader: "<forged-2@example.net>",
		});
		expect(again.thread.id).toBe(forged.thread.id);
	});

	it("scopes the subject fallback the same way", async () => {
		const db = fixture();
		const trusted = await ingestInboundTediEmail(db, {
			...mail("trusted", "ana@acme.example"),
			inReplyTo: null,
			references: [],
		});
		const stranger = await ingestInboundTediEmail(db, {
			...mail("untrusted", "stranger@example.net"),
			inReplyTo: null,
			references: [],
		});
		expect(stranger.thread.id).not.toBe(trusted.thread.id);
		expect(stranger.thread.senderTrust).toBe("untrusted");
	});

	it("chunks a long References chain below D1's parameter limit", async () => {
		const db = fixture();
		const original = await ingestInboundTediEmail(db, {
			...mail("trusted", "ana@acme.example"),
			messageIdHeader: ROOT,
			inReplyTo: null,
			references: [],
		});
		const references = Array.from(
			{ length: 101 },
			(_, index) => `<reference-${index}@acme.example>`,
		);
		references[100] = ROOT;

		const reply = await ingestInboundTediEmail(db, {
			...mail("trusted", "ana@acme.example"),
			messageIdHeader: "<reply@acme.example>",
			inReplyTo: null,
			references,
		});

		expect(reply.thread.id).toBe(original.thread.id);
	});
});

describe("inbound thread timestamps", () => {
	it.each([
		["2026-10-22T12:00:00.000Z", "2026-10-23T12:00:00.000Z"],
		["2026-10-23T12:00:00.000Z", "2026-10-22T12:00:00.000Z"],
		["2026-10-23T12:00:00.000Z", "2026-10-23T12:00:00.000Z"],
	])(
		"preserves the latest timestamp for %s followed by %s",
		async (first, second) => {
			const db = fixture();
			const root = await ingestInboundTediEmail(db, {
				...mail("trusted", "ana@acme.example"),
				messageIdHeader: ROOT,
				receivedAt: first,
			});
			const reply = await ingestInboundTediEmail(db, {
				...mail("trusted", "ana@acme.example"),
				messageIdHeader: "<delayed@acme.example>",
				receivedAt: second,
			});
			expect(reply.thread.id).toBe(root.thread.id);
			expect(reply.thread.lastMessageAt).toBe([first, second].sort().at(-1));
			expect(reply.thread.unreadCount).toBe(2);
			expect(reply.message.receivedAt).toBe(second);
			const stored = await getTediEmailThread(db, {
				...SCOPE,
				threadId: root.thread.id,
			});
			expect(stored?.thread.lastMessageAt).toBe(reply.thread.lastMessageAt);
			expect(stored?.thread.unreadCount).toBe(2);
			expect(
				stored?.messages.map((message) => message.receivedAt).sort(),
			).toEqual([first, second].sort());
		},
	);

	it.each([false, true])(
		"keeps concurrent arrivals monotonic (reverse=%s)",
		async (reverse) => {
			const db = fixture();
			const root = await ingestInboundTediEmail(db, {
				...mail("trusted", "ana@acme.example"),
				messageIdHeader: ROOT,
				receivedAt: "2026-10-21T12:00:00.000Z",
			});
			const timestamps = [
				"2026-10-23T12:00:00.000Z",
				"2026-10-22T12:00:00.000Z",
			];
			if (reverse) timestamps.reverse();
			const replies = await Promise.all(
				timestamps.map((receivedAt, index) =>
					ingestInboundTediEmail(db, {
						...mail("trusted", "ana@acme.example"),
						messageIdHeader: `<concurrent-${index}@acme.example>`,
						receivedAt,
					}),
				),
			);
			expect(replies.every((reply) => reply.thread.id === root.thread.id)).toBe(
				true,
			);
			const stored = await getTediEmailThread(db, {
				...SCOPE,
				threadId: root.thread.id,
			});
			expect(stored?.thread.lastMessageAt).toBe("2026-10-23T12:00:00.000Z");
			expect(stored?.thread.unreadCount).toBe(3);
			expect(stored?.messages).toHaveLength(3);
			expect(
				stored?.messages.filter((message) => message.readAt === null),
			).toHaveLength(3);
			expect(
				stored?.messages.map((message) => message.receivedAt).sort(),
			).toEqual([root.message.receivedAt, ...timestamps].sort());
		},
	);
});
