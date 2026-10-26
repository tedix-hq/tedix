import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { createD1Facade } from "../test/d1-facade";
import { connectionInstances } from "../schema/connection-instances";
import { schemaDdl } from "../test/schema-ddl";
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
	sqlite.exec(schemaDdl(connectionInstances));
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

it("persists opt-in page limits, including deny-all, while defaults remain whole-account", async () => {
	const db = fixture();
	const resources = [
		{
			resourceType: "notion_page" as const,
			resourceId: "11111111-1111-4111-8111-111111111111",
		},
	];
	for (const [id, allowedResources] of [
		["default", undefined],
		["scoped", resources],
		["empty", []],
	] as const) {
		await createConnectionInstance(db, {
			id,
			ownerUserId: "alice",
			organizationId: "org-a",
			providerId: "notion",
			label: id,
			allowedResources:
				allowedResources === undefined ? undefined : [...allowedResources],
		});
	}
	const rows = await listConnectionInstances(db, { organizationId: "org-a" });
	expect(
		Object.fromEntries(rows.map((row) => [row.id, row.allowedResources])),
	).toEqual({ default: null, scoped: resources, empty: [] });
});
