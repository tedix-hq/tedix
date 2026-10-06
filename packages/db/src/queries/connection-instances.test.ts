import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { createD1Facade } from "../test/d1-facade";
import {
	clearConnectionGrants,
	createConnectionInstance,
	getConnectionInstance,
	listConnectionInstances,
	recordConnectionGrant,
	renameConnectionInstance,
} from "./connection-instances";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		`CREATE TABLE connection_instances (id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, organization_id TEXT, provider_id TEXT NOT NULL, label TEXT NOT NULL, token_ids TEXT NOT NULL, token_sub TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`,
	);
	return createDbQueryClient(createD1Facade(sqlite));
}

describe("personal connection instances on D1", () => {
	it("enforces owner and provider boundaries without storing secrets", async () => {
		const db = fixture();
		await createConnectionInstance(db, {
			id: "a",
			ownerUserId: "alice",
			providerId: "microsoft",
			label: "Business",
		});
		await createConnectionInstance(db, {
			id: "b",
			ownerUserId: "bob",
			providerId: "microsoft",
			label: "Personal",
		});
		expect(
			await getConnectionInstance(db, { userId: "bob" }, "a", "microsoft"),
		).toBeUndefined();
		expect(
			await getConnectionInstance(db, { userId: "alice" }, "a", "google"),
		).toBeUndefined();
		expect(
			await renameConnectionInstance(db, { userId: "bob" }, "a", "Hijacked"),
		).toEqual([]);
		expect(await clearConnectionGrants(db, { userId: "bob" }, "a")).toEqual([]);
		expect(
			(await listConnectionInstances(db, { userId: "alice" })).map(
				(row) => row.label,
			),
		).toEqual(["Business"]);
	});
	it("isolates organization slots from their creator's personal slots and other organizations", async () => {
		const db = fixture();
		for (const [id, organizationId] of [
			["a", "org-a"],
			["b", "org-b"],
		])
			await createConnectionInstance(db, {
				id,
				organizationId,
				ownerUserId: "alice",
				providerId: "google",
				label: id,
			});
		expect(await listConnectionInstances(db, { userId: "alice" })).toEqual([]);
		expect(
			(await listConnectionInstances(db, { organizationId: "org-a" })).map(
				(r) => r.id,
			),
		).toEqual(["a"]);
		expect(
			await getConnectionInstance(
				db,
				{ organizationId: "org-b" },
				"a",
				"google",
			),
		).toBeUndefined();
		expect(
			await renameConnectionInstance(db, { userId: "alice" }, "a", "Hijacked"),
		).toEqual([]);
		expect(
			await clearConnectionGrants(db, { organizationId: "org-b" }, "a"),
		).toEqual([]);
		await recordConnectionGrant(db, {
			owner: { organizationId: "org-a" },
			id: "a",
			providerId: "google",
			tokenId: "grant-a",
			tokenSub: "subject-a",
		});
		expect(
			(
				await getConnectionInstance(
					db,
					{ organizationId: "org-a" },
					"a",
					"google",
				)
			)?.tokenIds,
		).toEqual(["grant-a"]);
	});

	it("atomically pins subject, deduplicates grants and keeps identity after disconnect", async () => {
		const db = fixture();
		await createConnectionInstance(db, {
			id: "a",
			ownerUserId: "alice",
			providerId: "microsoft",
			label: "Business",
		});
		const grant = {
			id: "a",
			owner: { userId: "alice" },
			providerId: "microsoft",
			tokenId: "grant-a",
			tokenSub: "subject-a",
		};
		await recordConnectionGrant(db, grant);
		await recordConnectionGrant(db, grant);
		await recordConnectionGrant(db, { ...grant, tokenId: "grant-b" });
		expect(
			(await getConnectionInstance(db, { userId: "alice" }, "a", "microsoft"))
				?.tokenIds,
		).toEqual(["grant-a", "grant-b"]);
		expect(
			await recordConnectionGrant(db, {
				...grant,
				tokenSub: "subject-b",
				tokenId: "wrong",
			}),
		).toEqual([]);
		await clearConnectionGrants(db, { userId: "alice" }, "a");
		const row = await getConnectionInstance(
			db,
			{ userId: "alice" },
			"a",
			"microsoft",
		);
		expect(row?.tokenIds).toEqual([]);
		expect(row?.tokenSub).toBe("subject-a");
		expect(
			await recordConnectionGrant(db, {
				...grant,
				tokenSub: "subject-b",
			}),
		).toEqual([]);
		await renameConnectionInstance(
			db,
			{ userId: "alice" },
			"a",
			"Work account",
		);
		expect(
			(await getConnectionInstance(db, { userId: "alice" }, "a", "microsoft"))
				?.label,
		).toBe("Work account");
	});
});
