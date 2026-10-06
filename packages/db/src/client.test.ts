/**
 * Session-scoped D1 access.
 *
 * The value of a session is that correctness comes from scope, not from
 * classifying each query: within one session D1 guarantees read-your-own-writes
 * even when reads may be served by a replica. These tests pin that a
 * session-backed Drizzle client is a working drop-in for the plain one, since
 * every query module takes `DbClient` and must not care which backs it.
 */

import { DatabaseSync } from "node:sqlite";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient, createDbSession, D1_BOOKMARK_HEADER } from "./client";
import { organizations } from "./schema/organizations";
import { createD1Facade } from "./test/d1-facade";
import { schemaDdl } from "./test/schema-ddl";

const NOW = "2026-07-30T00:00:00.000Z";

function d1() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(schemaDdl(organizations));
	return createD1Facade(sqlite);
}

describe("createDbSession", () => {
	it("reads its own writes within the session", async () => {
		const { db } = createDbSession(d1());

		await db.insert(organizations).values({
			id: "org-1",
			name: "Acme",
			slug: "acme",
			createdAt: NOW,
			updatedAt: NOW,
		});

		// The guarantee that makes replica reads safe without per-query reasoning.
		const found = await db.query.organizations.findFirst({
			where: { slug: "acme" },
		});
		expect(found?.id).toBe("org-1");
	});

	it("is a drop-in for the plain client, including the relational builder", async () => {
		const binding = d1();
		const plain = createDbClient(binding);
		await plain.insert(organizations).values({
			id: "org-2",
			name: "Beta",
			slug: "beta",
			createdAt: NOW,
			updatedAt: NOW,
		});

		const { db } = createDbSession(binding);
		expect(
			(
				await db
					.select()
					.from(organizations)
					.where(eq(organizations.slug, "beta"))
			).length,
		).toBe(1);
		expect(
			(await db.query.organizations.findFirst({ where: { slug: "beta" } }))
				?.name,
		).toBe("Beta");
	});

	it("has no bookmark before the first query and one after", async () => {
		const session = createDbSession(d1());
		expect(session.getBookmark()).toBeNull();

		await session.db.select().from(organizations);
		expect(session.getBookmark()).toEqual(expect.any(String));
	});

	it("prefers a supplied bookmark over the constraint", async () => {
		const resumed = createDbSession(d1(), "bookmark-from-caller");
		await resumed.db.select().from(organizations);
		expect(resumed.getBookmark()).toContain("bookmark-from-caller");

		// Blank/whitespace bookmarks are treated as absent rather than passed through.
		const fresh = createDbSession(d1(), "   ");
		await fresh.db.select().from(organizations);
		expect(fresh.getBookmark()).toContain("first-unconstrained");
	});

	it("honours an explicit first-primary constraint", async () => {
		const session = createDbSession(d1(), null, "first-primary");
		await session.db.select().from(organizations);
		expect(session.getBookmark()).toContain("first-primary");
	});

	it("exposes the header name callers must echo", () => {
		expect(D1_BOOKMARK_HEADER).toBe("x-d1-bookmark");
	});
});
