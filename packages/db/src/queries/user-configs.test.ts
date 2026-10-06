import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { userConfigs } from "../schema/user-configs";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	getUserConfig,
	listUserConfigs,
	putUserConfig,
	upsertUserConfig,
} from "./user-configs";

function createDb() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(schemaDdl(userConfigs));
	return createDbQueryClient(createD1Facade(sqlite));
}

describe("user configs", () => {
	it("lists only the requested user and namespace in stable key order", async () => {
		const db = createDb();
		await upsertUserConfig(db, {
			userId: "user-1",
			namespace: "os:org-1",
			key: "workspace-b",
			value: { favorite: false },
		});
		await upsertUserConfig(db, {
			userId: "user-1",
			namespace: "os:org-1",
			key: "workspace-a",
			value: { favorite: true },
		});
		await upsertUserConfig(db, {
			userId: "user-2",
			namespace: "os:org-1",
			key: "workspace-c",
			value: { favorite: true },
		});
		await upsertUserConfig(db, {
			userId: "user-1",
			namespace: "os:org-2",
			key: "workspace-d",
			value: { favorite: true },
		});

		const rows = await listUserConfigs(db, {
			userId: "user-1",
			namespace: "os:org-1",
		});

		expect(rows.map((row) => row.key)).toEqual(["workspace-a", "workspace-b"]);
	});

	it("updates one value without creating a duplicate", async () => {
		const db = createDb();
		const input = {
			userId: "user-1",
			namespace: "os:org-1",
			key: "workspace-a",
		};
		await upsertUserConfig(db, { ...input, value: { favorite: false } });
		await upsertUserConfig(db, {
			...input,
			value: { favorite: true, lastOpenedAt: "2026-08-17T12:00:00.000Z" },
		});

		const row = await getUserConfig(db, input);
		expect(row?.value).toEqual({
			favorite: true,
			lastOpenedAt: "2026-08-17T12:00:00.000Z",
		});
		expect(
			await listUserConfigs(db, {
				userId: input.userId,
				namespace: input.namespace,
			}),
		).toHaveLength(1);
	});
});

const NS = "os.preferences";
const USER = "user-1";
const ORG_A = "org-a";
const ORG_B = "org-b";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	// DDL derived from the production table object, so a column added by a
	// migration cannot go unexercised here.
	sqlite.exec(schemaDdl(userConfigs));
	return { db: createDbQueryClient(createD1Facade(sqlite)), sqlite };
}

function readRows(
	sqlite: DatabaseSync,
	key = ORG_A,
): { value: string; revision: number }[] {
	return sqlite
		.prepare(
			`SELECT value, revision FROM user_configs
			 WHERE user_id = ? AND namespace = ? AND key = ?`,
		)
		.all(USER, NS, key) as unknown as { value: string; revision: number }[];
}

function put(
	db: ReturnType<typeof fixture>["db"],
	theme: string,
	expectedRevision: number,
	key = ORG_A,
) {
	return putUserConfig(db, {
		userId: USER,
		namespace: NS,
		key,
		value: { theme },
		expectedRevision,
	});
}

describe("putUserConfig compare-and-swap", () => {
	it("creates at revision 1 and persists the exact value", async () => {
		const { db, sqlite } = fixture();
		const result = await put(db, "dark", 0);
		expect(result.ok).toBe(true);

		const rows = readRows(sqlite);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.revision).toBe(1);
		expect(JSON.parse(rows[0]?.value ?? "null")).toEqual({ theme: "dark" });
	});

	it("advances the revision and replaces the value on a matching swap", async () => {
		const { db, sqlite } = fixture();
		await put(db, "dark", 0);
		const result = await put(db, "light", 1);

		expect(result).toMatchObject({ ok: true });
		const rows = readRows(sqlite);
		expect(rows[0]?.revision).toBe(2);
		expect(JSON.parse(rows[0]?.value ?? "null")).toEqual({ theme: "light" });
	});

	it("refuses a stale expectation and leaves the stored row untouched", async () => {
		const { db, sqlite } = fixture();
		await put(db, "dark", 0);
		await put(db, "light", 1);

		const stale = await put(db, "clobber", 1);
		expect(stale).toEqual({
			ok: false,
			reason: "revision_conflict",
			currentRevision: 2,
		});

		const rows = readRows(sqlite);
		expect(rows[0]?.revision).toBe(2);
		expect(JSON.parse(rows[0]?.value ?? "null")).toEqual({ theme: "light" });
	});

	it("refuses a second create against an existing row", async () => {
		// The second-tab case: both tabs read nothing, both save. The loser must
		// be told, not silently overwrite the winner.
		const { db, sqlite } = fixture();
		await put(db, "dark", 0);

		const second = await put(db, "light", 0);
		expect(second).toEqual({
			ok: false,
			reason: "revision_conflict",
			currentRevision: 1,
		});
		expect(JSON.parse(readRows(sqlite)[0]?.value ?? "null")).toEqual({
			theme: "dark",
		});
	});

	it("never CREATES a row for a caller that expected an existing revision", async () => {
		// An unconditional upsert would insert here, resurrecting state the
		// caller believed it was updating. Nothing may be written.
		const { db, sqlite } = fixture();
		const result = await put(db, "dark", 5);

		expect(result).toEqual({
			ok: false,
			reason: "revision_conflict",
			currentRevision: null,
		});
		expect(readRows(sqlite)).toHaveLength(0);
	});

	it("adopts a pre-CAS row still sitting at revision 0", async () => {
		const { db, sqlite } = fixture();
		sqlite
			.prepare(
				`INSERT INTO user_configs (id, user_id, namespace, key, value, revision)
				 VALUES (?, ?, ?, ?, ?, 0)`,
			)
			.run("legacy-1", USER, NS, ORG_A, JSON.stringify({ theme: "system" }));

		const result = await put(db, "dark", 0);
		expect(result.ok).toBe(true);

		const rows = readRows(sqlite);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.revision).toBe(1);
		expect(JSON.parse(rows[0]?.value ?? "null")).toEqual({ theme: "dark" });
	});

	it("keeps one user's two organization keys independent", async () => {
		// The key carries the organization id, so it is the ONLY thing separating
		// a member's preferences in one tenant from the same member's in another.
		const { db, sqlite } = fixture();
		await put(db, "dark", 0, ORG_A);
		await put(db, "light", 0, ORG_B);
		await put(db, "system", 1, ORG_A);

		expect(readRows(sqlite, ORG_A)[0]).toMatchObject({ revision: 2 });
		expect(JSON.parse(readRows(sqlite, ORG_A)[0]?.value ?? "null")).toEqual({
			theme: "system",
		});
		expect(readRows(sqlite, ORG_B)[0]).toMatchObject({ revision: 1 });
		expect(JSON.parse(readRows(sqlite, ORG_B)[0]?.value ?? "null")).toEqual({
			theme: "light",
		});
	});
});

describe("getUserConfig", () => {
	it("reads only the exact (user, namespace, key) triple", async () => {
		const { db } = fixture();
		await put(db, "dark", 0, ORG_A);

		await expect(
			getUserConfig(db, { userId: USER, namespace: NS, key: ORG_A }),
		).resolves.toMatchObject({ revision: 1, value: { theme: "dark" } });
		await expect(
			getUserConfig(db, { userId: USER, namespace: NS, key: ORG_B }),
		).resolves.toBeNull();
		await expect(
			getUserConfig(db, { userId: "other", namespace: NS, key: ORG_A }),
		).resolves.toBeNull();
	});
});
