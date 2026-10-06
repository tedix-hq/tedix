import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { schemaDdl } from "../test/schema-ddl";
import { createD1Facade } from "../test/d1-facade";
import { osShareLinks, osShareSessions } from "../schema/os-shares";
import {
	createOsShareSession,
	createOsShareLink,
	deleteOsShareLink,
	getOsShareLinkByTokenHash,
	listOsShareLinks,
	restrictOsShareLink,
	revokeOsShareLink,
} from "./os-shares";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	// Org scope is bound into every predicate; FKs stay off like sibling suites.
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(schemaDdl(osShareLinks, osShareSessions));
	return { db: createDbQueryClient(createD1Facade(sqlite)) };
}

function link(id: string, overrides: Record<string, string | null> = {}) {
	return {
		id,
		organizationId: "org-1",
		resourceType: "output" as const,
		resourceId: "out-1",
		tokenHash: `hash-${id}`,
		role: "viewer" as const,
		createdByKind: "user" as const,
		createdById: "user-1",
		createdAt: "2026-08-14T10:00:00.000Z",
		expiresAt: null,
		revokedAt: null,
		...overrides,
	};
}

describe("os share links", () => {
	it("creates and lists per resource newest-first, org-scoped", async () => {
		const { db } = fixture();
		await createOsShareLink(db, link("s-1"));
		await createOsShareLink(
			db,
			link("s-2", { createdAt: "2026-08-15T10:00:00.000Z" }),
		);
		await createOsShareLink(db, link("s-other", { resourceId: "out-2" }));

		const rows = await listOsShareLinks(db, {
			organizationId: "org-1",
			resourceType: "output",
			resourceId: "out-1",
		});
		expect(rows.map((row) => row.id)).toEqual(["s-2", "s-1"]);
		expect(rows[0]).toMatchObject({ role: "viewer", resourceType: "output" });
		expect(
			await listOsShareLinks(db, {
				organizationId: "org-2",
				resourceType: "output",
				resourceId: "out-1",
			}),
		).toHaveLength(0);
	});

	it("rejects a duplicate token hash", async () => {
		const { db } = fixture();
		await createOsShareLink(db, link("s-1"));
		// Drizzle wraps the driver error; the UNIQUE detail lives on the cause.
		const failure: unknown = await createOsShareLink(
			db,
			link("s-2", { tokenHash: "hash-s-1" }),
		).then(
			() => null,
			(error: unknown) => error,
		);
		expect(failure).toBeInstanceOf(Error);
		expect(String((failure as Error).cause ?? failure)).toMatch(/unique/i);
	});

	it("revokes idempotently and only inside the organization", async () => {
		const { db } = fixture();
		await createOsShareLink(db, link("s-1"));
		expect(
			await revokeOsShareLink(db, {
				organizationId: "org-2",
				shareLinkId: "s-1",
			}),
		).toBeUndefined();

		const revoked = await revokeOsShareLink(db, {
			organizationId: "org-1",
			shareLinkId: "s-1",
		});
		expect(revoked?.revokedAt).toBeTruthy();

		const again = await revokeOsShareLink(db, {
			organizationId: "org-1",
			shareLinkId: "s-1",
		});
		// coalesce keeps the first revocation timestamp.
		expect(again?.revokedAt).toBe(revoked?.revokedAt);
	});

	it("permanently deletes only inside the owning organization", async () => {
		const { db } = fixture();
		await createOsShareLink(
			db,
			link("s-1", { revokedAt: "2026-08-15T00:00:00.000Z" }),
		);
		expect(
			await deleteOsShareLink(db, {
				organizationId: "org-2",
				shareLinkId: "s-1",
			}),
		).toBe(false);
		expect(
			await deleteOsShareLink(db, {
				organizationId: "org-1",
				shareLinkId: "s-1",
			}),
		).toBe(true);
		expect(await getOsShareLinkByTokenHash(db, "hash-s-1")).toBeUndefined();
	});

	it("resolves by token hash regardless of state; caller decides", async () => {
		const { db } = fixture();
		await createOsShareLink(
			db,
			link("s-1", { revokedAt: "2026-08-14T11:00:00.000Z" }),
		);
		expect(await getOsShareLinkByTokenHash(db, "hash-s-1")).toMatchObject({
			id: "s-1",
			revokedAt: "2026-08-14T11:00:00.000Z",
		});
		expect(await getOsShareLinkByTokenHash(db, "missing")).toBeUndefined();
	});

	it("keeps policy ceilings monotonic and revokes sessions only on tightening", async () => {
		const { db } = fixture();
		await createOsShareLink(db, link("s-1", { role: "build" }));
		await db.insert(osShareSessions).values({
			id: "session-1",
			shareLinkId: "s-1",
			sessionTokenHash: "session-hash-1",
			createdAt: "2026-08-14T10:00:00.000Z",
			lastSeenAt: "2026-08-14T10:00:00.000Z",
			expiresAt: "2099-01-01T00:00:00.000Z",
			revokedAt: null,
		});

		const narrowed = await restrictOsShareLink(db, {
			organizationId: "org-1",
			shareLinkId: "s-1",
			maxRole: "use",
			reason: "Sensitive observation",
			now: "2026-08-14T11:00:00.000Z",
		});
		expect(narrowed).toMatchObject({
			share: { policyMaxRole: "use" },
			revokedSessionCount: 1,
		});

		await db.insert(osShareSessions).values({
			id: "session-2",
			shareLinkId: "s-1",
			sessionTokenHash: "session-hash-2",
			createdAt: "2026-08-14T11:01:00.000Z",
			lastSeenAt: "2026-08-14T11:01:00.000Z",
			expiresAt: "2099-01-01T00:00:00.000Z",
			revokedAt: null,
		});
		const reaffirmed = await restrictOsShareLink(db, {
			organizationId: "org-1",
			shareLinkId: "s-1",
			maxRole: "use",
			reason: "Reaffirmed",
			now: "2026-08-14T11:02:00.000Z",
		});
		expect(reaffirmed?.revokedSessionCount).toBe(0);

		expect(
			await restrictOsShareLink(db, {
				organizationId: "org-1",
				shareLinkId: "s-1",
				maxRole: "build",
				reason: "Attempted widening",
			}),
		).toBeUndefined();
		const tightened = await restrictOsShareLink(db, {
			organizationId: "org-1",
			shareLinkId: "s-1",
			maxRole: "viewer",
			reason: "Further restriction",
			now: "2026-08-14T11:03:00.000Z",
		});
		expect(tightened).toMatchObject({
			share: { policyMaxRole: "viewer" },
			revokedSessionCount: 1,
		});
	});

	it("refuses redemption when the authorized role was concurrently tightened", async () => {
		const { db } = fixture();
		await createOsShareLink(db, link("s-1", { role: "build" }));
		await restrictOsShareLink(db, {
			organizationId: "org-1",
			shareLinkId: "s-1",
			maxRole: "use",
			reason: "Concurrent restriction",
		});
		expect(
			await createOsShareSession(db, {
				id: "session-1",
				sessionTokenHash: "session-hash-1",
				createdAt: "2026-08-14T11:00:00.000Z",
				lastSeenAt: "2026-08-14T11:00:00.000Z",
				expiresAt: "2099-01-01T00:00:00.000Z",
				linkTokenHash: "hash-s-1",
				expectedEffectiveRole: "build",
				now: "2026-08-14T11:00:00.000Z",
			}),
		).toBeUndefined();
	});

	it("concurrent restrictions converge on the narrowest ceiling", async () => {
		const { db } = fixture();
		await createOsShareLink(db, link("s-1", { role: "build" }));
		await Promise.all([
			restrictOsShareLink(db, {
				organizationId: "org-1",
				shareLinkId: "s-1",
				maxRole: "use",
				reason: "Moderate restriction",
			}),
			restrictOsShareLink(db, {
				organizationId: "org-1",
				shareLinkId: "s-1",
				maxRole: "viewer",
				reason: "Strict restriction",
			}),
		]);
		expect(await getOsShareLinkByTokenHash(db, "hash-s-1")).toMatchObject({
			policyMaxRole: "viewer",
		});
	});
});
