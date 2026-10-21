import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../client";
import { auditEvents } from "../schema/audit-events";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	buildInsertAuditEventStatement,
	getAuditEventsByResource,
	insertAuditEvent,
	type InsertAuditEventParams,
	searchAuditEvents,
} from "./audit";

const tiedAt = new Date("2026-01-02T12:00:00Z");
const olderAt = new Date("2026-01-01T12:00:00Z");
const newerAt = new Date("2026-01-03T12:00:00Z");
const event: InsertAuditEventParams = {
	organizationId: "org-first",
	actorId: "actor-first",
	actorType: "user",
	action: "document.updated",
	resourceType: "document",
	resourceId: "document-first",
	occurredAt: tiedAt,
};

let sqlite: DatabaseSync;
let db: DbClient;
beforeEach(() => {
	sqlite = new DatabaseSync(":memory:");
	sqlite.exec(schemaDdl(auditEvents));
	db = createDbClient(createD1Facade(sqlite));
});
afterEach(() => sqlite.close());

async function seedHistory() {
	for (const id of ["tie-b", "tie-d", "tie-a", "tie-c"]) {
		await insertAuditEvent(db, { ...event, id });
	}
	await insertAuditEvent(db, { ...event, id: "z-old", occurredAt: olderAt });
	await insertAuditEvent(db, { ...event, id: "a-new", occurredAt: newerAt });
	await insertAuditEvent(db, {
		...event,
		id: "other-org",
		organizationId: "org-second",
	});
	await insertAuditEvent(db, {
		...event,
		id: "other-resource",
		resourceId: "document-second",
	});
	await insertAuditEvent(db, {
		...event,
		id: "other-type",
		resourceType: "folder",
	});
	await insertAuditEvent(db, {
		...event,
		id: "other-actor",
		actorId: "actor-second",
	});
	await insertAuditEvent(db, {
		...event,
		id: "other-action",
		action: "document.created",
	});
}

const filters = {
	organizationId: event.organizationId,
	actorId: event.actorId,
	action: event.action,
	resourceType: event.resourceType,
	resourceId: "document-first",
};

describe("audit history ordering", () => {
	it("keeps exact timestamp/ID order across offset pages and inclusive date filters", async () => {
		await seedHistory();
		const expected = ["a-new", "tie-d", "tie-c", "tie-b", "tie-a", "z-old"];
		for (let repeat = 0; repeat < 2; repeat++) {
			for (const offset of [0, 2, 4, 6]) {
				const page = await searchAuditEvents(db, {
					...filters,
					limit: 2,
					offset,
				});
				expect(page.data.map((row) => row.id)).toEqual(
					expected.slice(offset, offset + 2),
				);
				expect(page.total).toBe(6);
			}
		}
		const tied = await searchAuditEvents(db, {
			...filters,
			startDate: tiedAt.toISOString(),
			endDate: tiedAt.toISOString(),
			limit: 2,
			offset: 1,
		});
		expect(tied.data.map((row) => row.id)).toEqual(["tie-c", "tie-b"]);
		expect(tied.total).toBe(4);
		const bounded = await searchAuditEvents(db, {
			...filters,
			startDate: olderAt.toISOString(),
			endDate: newerAt.toISOString(),
		});
		expect(bounded.data.map((row) => row.id)).toEqual(expected);
		expect(bounded.total).toBe(6);
		const tenant = await searchAuditEvents(db, {
			organizationId: "org-second",
		});
		expect(tenant.data.map((row) => row.id)).toEqual(["other-org"]);
		expect(tenant.total).toBe(1);
	});

	it("uses the same tied order for resource history and its limit", async () => {
		await seedHistory();
		const expected = [
			"a-new",
			"tie-d",
			"tie-c",
			"tie-b",
			"tie-a",
			"other-actor",
			"other-action",
			"z-old",
		];
		for (const limit of [3, 100]) {
			const rows = await getAuditEventsByResource(
				db,
				"org-first",
				"document",
				"document-first",
				limit,
			);
			expect(rows.map((row) => row.id)).toEqual(expected.slice(0, limit));
		}
		expect(
			(
				await getAuditEventsByResource(
					db,
					"org-second",
					"document",
					"document-first",
				)
			).map((row) => row.id),
		).toEqual(["other-org"]);
		expect(
			await getAuditEventsByResource(db, "org-first", "document", "missing"),
		).toEqual([]);
	});
});

describe("audit evidence insertion", () => {
	it("rejects ordinary duplicate IDs without changing the original evidence", async () => {
		await insertAuditEvent(db, {
			...event,
			id: "duplicate",
			metadata: { original: true },
		});
		const original = await db.select().from(auditEvents);
		await expect(
			insertAuditEvent(db, { ...event, id: "duplicate", action: "rewritten" }),
		).rejects.toThrow();
		expect(await db.select().from(auditEvents)).toEqual(original);
	});

	it("constructs unexecuted D1 batch statements and ignores redelivery without overwriting", async () => {
		const first = buildInsertAuditEventStatement(db, {
			...event,
			id: "deterministic",
			metadata: { original: true },
			ipAddress: "192.0.2.1",
			userAgent: "fixture",
		});
		const second = buildInsertAuditEventStatement(db, {
			...event,
			id: "second",
		});
		expect(first.id).toBe("deterministic");
		expect(await db.$count(auditEvents)).toBe(0);
		await db.batch([first.statement, second.statement]);
		const original = await searchAuditEvents(db, {
			organizationId: "org-first",
		});
		const redelivery = buildInsertAuditEventStatement(db, {
			...event,
			id: "deterministic",
			ignoreDuplicates: true,
			organizationId: "org-second",
			actorId: "changed",
			actorType: "service",
			action: "changed",
			resourceType: "changed",
			resourceId: "changed",
			metadata: { original: false },
			ipAddress: "192.0.2.2",
			userAgent: "changed",
			occurredAt: newerAt,
		});
		await db.batch([redelivery.statement]);
		expect(
			await searchAuditEvents(db, { organizationId: "org-first" }),
		).toEqual(original);
		expect(await db.$count(auditEvents)).toBe(2);
		expect(
			(await searchAuditEvents(db, { organizationId: "org-second" })).total,
		).toBe(0);
	});
});
