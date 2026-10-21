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
import { appAdapterSecretBindings } from "../schema/app-adapter-secret-bindings";
import { appSecrets } from "../schema/app-secrets";
import { organizationSecrets } from "../schema/organization-secrets";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	getBindingById,
	getBindingsBatch,
	listBindingsForAdapter,
	listBindingsForApp,
	setBinding,
} from "./app-adapter-secret-bindings";

const CREATED_AT = "2026-01-01T00:00:00.000Z";
const UPDATED_AT = "2026-01-02T00:00:00.000Z";
let sqlite: DatabaseSync;
let db: ReturnType<typeof createDbClient>;
let statements: string[];

beforeEach(() => {
	sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(
		schemaDdl(appAdapterSecretBindings, appSecrets, organizationSecrets),
	);
	statements = [];
	db = createDbClient(
		createD1Facade(sqlite, {
			onPrepare: (query) => statements.push(query),
		}),
	);
	vi.useFakeTimers();
	vi.setSystemTime(new Date(CREATED_AT));
});

afterEach(() => {
	vi.useRealTimers();
	sqlite.close();
});

describe("adapter secret binding upserts", () => {
	it("inserts a first binding and returns its stored identity", async () => {
		const binding = await setBinding(
			db,
			"adapter-a",
			"app-a",
			"auth.token",
			"secret-a",
			"app",
		);
		expect(binding).toEqual({
			id: expect.any(String),
			adapterId: "adapter-a",
			appId: "app-a",
			configPath: "auth.token",
			secretId: "secret-a",
			secretScope: "app",
			createdAt: CREATED_AT,
			updatedAt: CREATED_AT,
		});
		expect(await getBindingById(db, binding.id)).toEqual(binding);
	});

	it("updates only the reference, scope and update timestamp", async () => {
		const original = await setBinding(
			db,
			"adapter-a",
			"app-a",
			"auth.token",
			"secret-a",
			"app",
		);
		vi.setSystemTime(new Date(UPDATED_AT));
		const updated = await setBinding(
			db,
			"adapter-a",
			"app-other",
			"auth.token",
			"secret-org",
			"organization",
		);
		expect(updated).toEqual({
			...original,
			secretId: "secret-org",
			secretScope: "organization",
			updatedAt: UPDATED_AT,
		});
		const repeated = await setBinding(
			db,
			"adapter-a",
			"app-other",
			"auth.token",
			"secret-org",
			"organization",
		);
		expect(repeated).toEqual(updated);
		expect(await listBindingsForApp(db, "app-other")).toEqual([]);
	});

	it("saves concurrent same-path writes after both callers observe no binding", async () => {
		const otherWriter = createDbClient(createD1Facade(sqlite));
		const observations = await Promise.all([
			getBindingsBatch(db, ["adapter-a"]),
			getBindingsBatch(otherWriter, ["adapter-a"]),
		]);
		expect(observations.map((bindings) => bindings.size)).toEqual([0, 0]);

		const [first, second] = await Promise.all([
			setBinding(db, "adapter-a", "app-a", "auth.token", "secret-a", "app"),
			setBinding(
				otherWriter,
				"adapter-a",
				"app-a",
				"auth.token",
				"secret-org",
				"organization",
			),
		]);
		expect(second.id).toBe(first.id);
		expect(second.createdAt).toBe(first.createdAt);
		expect(first.secretId).toBe("secret-a");
		expect(second.secretId).toBe("secret-org");
		expect(second.secretScope).toBe("organization");
		expect(
			(await getBindingsBatch(db, ["adapter-a"])).get("adapter-a"),
		).toEqual([second]);
	});

	it("keeps distinct paths and adapters independent during concurrent saves", async () => {
		const bindings = await Promise.all([
			setBinding(db, "adapter-a", "app-a", "auth.token", "secret-a", "app"),
			setBinding(
				db,
				"adapter-a",
				"app-a",
				"auth.clientSecret",
				"secret-b",
				"app",
			),
			setBinding(
				db,
				"adapter-b",
				"app-b",
				"auth.token",
				"secret-org",
				"organization",
			),
		]);
		expect(new Set(bindings.map((binding) => binding.id)).size).toBe(3);
		const stored = await getBindingsBatch(db, ["adapter-a", "adapter-b"]);
		expect(stored.get("adapter-a")).toEqual(
			expect.arrayContaining(bindings.slice(0, 2)),
		);
		expect(stored.get("adapter-a")).toHaveLength(2);
		expect(stored.get("adapter-b")).toEqual([bindings[2]]);
	});

	it("reads scoped metadata without selecting encrypted or decrypted values", async () => {
		await db.insert(appSecrets).values({
			id: "shared-secret-id",
			appId: "app-a",
			name: "App token",
			hint: "app-hint",
			encryptedValue: "synthetic-app-ciphertext",
			createdAt: CREATED_AT,
			updatedAt: CREATED_AT,
		});
		await db.insert(organizationSecrets).values({
			id: "shared-secret-id",
			organizationId: "org-a",
			name: "Organization token",
			hint: "org-hint",
			encryptedValue: "synthetic-org-ciphertext",
			createdAt: CREATED_AT,
			updatedAt: CREATED_AT,
		});
		const appBinding = await setBinding(
			db,
			"adapter-a",
			"app-a",
			"auth.token",
			"shared-secret-id",
			"app",
		);
		const orgBinding = await setBinding(
			db,
			"adapter-a",
			"app-a",
			"auth.clientSecret",
			"shared-secret-id",
			"organization",
		);
		statements.length = 0;
		for (const metadata of [
			await listBindingsForAdapter(db, "adapter-a"),
			await listBindingsForApp(db, "app-a"),
		]) {
			expect(metadata).toHaveLength(2);
			expect(metadata).toEqual(
				expect.arrayContaining([
					{ ...appBinding, secretName: "App token", secretHint: "app-hint" },
					{
						...orgBinding,
						secretName: "Organization token",
						secretHint: "org-hint",
					},
				]),
			);
		}
		expect(statements).toHaveLength(2);
		for (const query of statements)
			expect(query).not.toMatch(/encrypted_value|decrypted/i);
	});
});
