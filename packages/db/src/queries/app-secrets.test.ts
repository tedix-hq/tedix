import { DatabaseSync } from "node:sqlite";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import { createDbClient } from "../client";
import { type AppSecret, appSecrets } from "../schema/app-secrets";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	createAppSecret,
	deleteAppSecret,
	getAppSecret,
	getAppSecretById,
	listAppSecrets,
	updateAppSecret,
} from "./app-secrets";

const CREATED_AT = "2026-01-01T00:00:00.000Z";
const ROTATED_AT = "2026-02-01T00:00:00.000Z";

// Two fictional apps hold a secret under the same name, with distinct
// ciphertext and hints, so any app/name lookup mix-up shows up immediately.
const SECRET_A_SHARED: AppSecret = {
	id: "secret-a-shared",
	appId: "app-a",
	name: "SHARED_KEY",
	encryptedValue: "ciphertext-app-a",
	hint: "...aaaa",
	keyVersion: 3,
	createdBy: "user-a",
	createdAt: CREATED_AT,
	updatedAt: CREATED_AT,
};
const SECRET_A_ONLY: AppSecret = {
	id: "secret-a-only",
	appId: "app-a",
	name: "A_ONLY_KEY",
	encryptedValue: "ciphertext-app-a-second",
	hint: null,
	keyVersion: 1,
	createdBy: null,
	createdAt: CREATED_AT,
	updatedAt: CREATED_AT,
};
const SECRET_B_SHARED: AppSecret = {
	id: "secret-b-shared",
	appId: "app-b",
	name: "SHARED_KEY",
	encryptedValue: "ciphertext-app-b",
	hint: "...bbbb",
	keyVersion: 7,
	createdBy: "user-b",
	createdAt: CREATED_AT,
	updatedAt: CREATED_AT,
};

let sqlite: DatabaseSync;
let db: ReturnType<typeof createDbClient>;
let statements: string[];

/** The metadata shape listAppSecrets is allowed to expose. */
function metadata(row: AppSecret) {
	return {
		id: row.id,
		name: row.name,
		hint: row.hint,
		keyVersion: row.keyVersion,
		createdBy: row.createdBy,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

beforeEach(async () => {
	sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(schemaDdl(appSecrets));
	statements = [];
	db = createDbClient(
		createD1Facade(sqlite, {
			onPrepare: (query) => statements.push(query),
		}),
	);
	vi.useFakeTimers();
	vi.setSystemTime(new Date(CREATED_AT));
	await db
		.insert(appSecrets)
		.values([SECRET_A_SHARED, SECRET_A_ONLY, SECRET_B_SHARED]);
});

afterEach(() => {
	vi.useRealTimers();
	sqlite.close();
});

describe("listAppSecrets", () => {
	it("returns metadata only: no ciphertext, no app scope column", async () => {
		statements.length = 0;
		const rows = await listAppSecrets(db, "app-a");

		expect(rows).toEqual(
			expect.arrayContaining([
				metadata(SECRET_A_SHARED),
				metadata(SECRET_A_ONLY),
			]),
		);
		expect(rows).toHaveLength(2);
		for (const row of rows) {
			expect(Object.keys(row).sort()).toEqual([
				"createdAt",
				"createdBy",
				"hint",
				"id",
				"keyVersion",
				"name",
				"updatedAt",
			]);
		}
	});

	it("pins the exact select list so a future column cannot leak in", async () => {
		statements.length = 0;
		await listAppSecrets(db, "app-a");

		expect(statements).toHaveLength(1);
		expect(statements[0]).toContain(
			'"id", "name", "hint", "key_version", "created_by", "created_at", "updated_at"',
		);
		expect(statements[0]).not.toMatch(/encrypted_value/i);
	});

	it("returns only the requested app's rows", async () => {
		const appBRows = await listAppSecrets(db, "app-b");
		expect(appBRows).toEqual([metadata(SECRET_B_SHARED)]);
		expect(await listAppSecrets(db, "app-c")).toEqual([]);
	});
});

describe("getAppSecret", () => {
	it("keys the lookup by app id and name", async () => {
		expect(await getAppSecret(db, "app-a", "SHARED_KEY")).toEqual(
			SECRET_A_SHARED,
		);
		expect(await getAppSecret(db, "app-b", "SHARED_KEY")).toEqual(
			SECRET_B_SHARED,
		);
	});

	it("does not reach across apps even when the name matches", async () => {
		expect(await getAppSecret(db, "app-b", "A_ONLY_KEY")).toBeUndefined();
		expect(await getAppSecret(db, "app-c", "SHARED_KEY")).toBeUndefined();
		expect(await getAppSecretById(db, "secret-missing")).toBeUndefined();
	});
});

describe("createAppSecret / updateAppSecret / deleteAppSecret", () => {
	it("creates a secret and reads it back in full", async () => {
		const created = await createAppSecret(db, {
			appId: "app-b",
			name: "NEW_KEY",
			encryptedValue: "ciphertext-new",
			hint: "...new",
			keyVersion: 1,
			createdBy: "user-b",
		});

		expect(created).toEqual({
			id: expect.any(String),
			appId: "app-b",
			name: "NEW_KEY",
			encryptedValue: "ciphertext-new",
			hint: "...new",
			keyVersion: 1,
			createdBy: "user-b",
			createdAt: CREATED_AT,
			updatedAt: CREATED_AT,
		});
		expect(await getAppSecretById(db, created.id)).toEqual(created);
	});

	it("surfaces the per-app name uniqueness violation", async () => {
		await expect(
			createAppSecret(db, {
				appId: "app-a",
				name: "SHARED_KEY",
				encryptedValue: "ciphertext-duplicate",
				hint: null,
				keyVersion: 1,
				createdBy: null,
			}),
		).rejects.toThrow();
		expect(await getAppSecret(db, "app-a", "SHARED_KEY")).toEqual(
			SECRET_A_SHARED,
		);
	});

	it("rotates ciphertext, hint and key version with a fresh timestamp", async () => {
		vi.setSystemTime(new Date(ROTATED_AT));
		const updated = await updateAppSecret(db, SECRET_A_SHARED.id, {
			encryptedValue: "ciphertext-rotated",
			hint: "...rot",
			keyVersion: SECRET_A_SHARED.keyVersion + 1,
		});

		expect(updated).toEqual({
			...SECRET_A_SHARED,
			encryptedValue: "ciphertext-rotated",
			hint: "...rot",
			keyVersion: 4,
			updatedAt: ROTATED_AT,
		});
		expect(await getAppSecretById(db, SECRET_B_SHARED.id)).toEqual(
			SECRET_B_SHARED,
		);
	});

	it("returns undefined when updating a missing id", async () => {
		expect(
			await updateAppSecret(db, "secret-missing", {
				encryptedValue: "ciphertext-rotated",
			}),
		).toBeUndefined();
	});

	it("reports false for a missing id and true for a real delete", async () => {
		expect(await deleteAppSecret(db, "secret-missing")).toBe(false);
		expect(await deleteAppSecret(db, SECRET_A_SHARED.id)).toBe(true);

		expect(await getAppSecretById(db, SECRET_A_SHARED.id)).toBeUndefined();
		// The peer app's same-named secret and the rest of app-a's rows survive.
		expect(await getAppSecret(db, "app-b", "SHARED_KEY")).toEqual(
			SECRET_B_SHARED,
		);
		expect((await listAppSecrets(db, "app-a")).map((row) => row.id)).toEqual([
			"secret-a-only",
		]);
		expect(await deleteAppSecret(db, SECRET_A_SHARED.id)).toBe(false);
	});
});

describe("database error handling", () => {
	it("surfaces errors instead of returning empty results", async () => {
		sqlite.exec("DROP TABLE app_secrets");

		await expect(listAppSecrets(db, "app-a")).rejects.toThrow();
		await expect(getAppSecretById(db, SECRET_A_SHARED.id)).rejects.toThrow();
		await expect(
			createAppSecret(db, {
				appId: "app-a",
				name: "NEW_KEY",
				encryptedValue: "ciphertext-new",
				hint: null,
				keyVersion: 1,
				createdBy: null,
			}),
		).rejects.toThrow();
	});
});
