import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { appConfigVersions } from "../schema/app-config-versions";
import { apps } from "../schema/apps";
import { appCatalog } from "../schema/catalog";
import { organizations } from "../schema/organizations";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	createAppConfigVersion,
	listAppConfigVersions,
} from "./app-config-versions";

const databases: DatabaseSync[] = [];
afterEach(() => {
	for (const sqlite of databases.splice(0)) sqlite.close();
});

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	databases.push(sqlite);
	sqlite.exec(schemaDdl(organizations, appCatalog, apps, appConfigVersions));
	sqlite.exec("PRAGMA foreign_keys = ON");
	sqlite.exec(`
		INSERT INTO organizations (id, name, slug) VALUES ('org', 'Example', 'example');
		INSERT INTO apps (id, organization_id, name, slug)
		VALUES ('app-a', 'org', 'App A', 'app-a'), ('app-b', 'org', 'App B', 'app-b');
	`);
	const facade = createD1Facade(sqlite);
	return { sqlite, facade, db: createDbClient(facade) };
}

function counter(sqlite: DatabaseSync, appId = "app-a") {
	return sqlite
		.prepare("SELECT latest_config_version FROM apps WHERE id = ?")
		.get(appId)?.latest_config_version;
}

describe("createAppConfigVersion on D1", () => {
	it("returns the persisted draft with its own identity and metadata", async () => {
		const { db, sqlite } = fixture();
		const input = {
			appId: "app-a",
			config: { nested: [1, true, null] },
			createdBy: "author",
			changeSummary: "Initial draft",
		};
		const row = await createAppConfigVersion(db, input);
		expect(row).toMatchObject({
			...input,
			version: 1,
			status: "draft",
			publishedAt: null,
			activatedAt: null,
		});
		expect(row.id).toBeTruthy();
		expect(row.createdAt).toBe(row.updatedAt);
		expect(await listAppConfigVersions(db, input.appId)).toEqual([row]);
		expect(counter(sqlite)).toBe(1);
	});

	it.each([
		{ stored: 3, latest: 9, expected: 10 },
		{ stored: 9, latest: 3, expected: 10 },
	])(
		"allocates above stored=$stored and counter=$latest",
		async ({ stored, latest, expected }) => {
			const { db, sqlite } = fixture();
			sqlite
				.prepare(
					"INSERT INTO app_config_versions (id, app_id, version, config) VALUES ('existing', 'app-a', ?, '{}')",
				)
				.run(stored);
			sqlite
				.prepare("UPDATE apps SET latest_config_version = ? WHERE id = 'app-a'")
				.run(latest);
			const row = await createAppConfigVersion(db, {
				appId: "app-a",
				config: {},
			});
			expect(row.version).toBe(expected);
			expect(counter(sqlite)).toBe(expected);
		},
	);

	it("keeps version allocation isolated between apps", async () => {
		const { db, sqlite } = fixture();
		sqlite.exec(
			"UPDATE apps SET latest_config_version = 40 WHERE id = 'app-b'",
		);
		const rows = await Promise.all([
			createAppConfigVersion(db, { appId: "app-a", config: "a" }),
			createAppConfigVersion(db, { appId: "app-b", config: "b" }),
		]);
		expect(rows.map((row) => row.version)).toEqual([1, 41]);
		expect(counter(sqlite, "app-a")).toBe(1);
		expect(counter(sqlite, "app-b")).toBe(41);
	});

	it("interleaves two creators and returns distinct increasing versions and identities", async () => {
		const { db, sqlite, facade } = fixture();
		let release!: () => void;
		const bothRead = new Promise<void>((resolve) => {
			release = resolve;
		});
		let readers = 0;
		const prepare = facade.prepare.bind(facade);
		// Hold both legacy allocation reads after their results are captured.
		// An atomic INSERT allocation has no separate SELECT to hold.
		facade.prepare = (query) =>
			new Proxy(prepare(query), {
				get(target, key, receiver) {
					if (key === "bind")
						return (...values: unknown[]) => {
							target.bind(...values);
							return receiver;
						};
					if (key !== "raw" || !/^select max\(/i.test(query))
						return Reflect.get(target, key);
					return async () => {
						const rows = await target.raw();
						if (++readers === 2) release();
						await bothRead;
						return rows;
					};
				},
			});
		const results = await Promise.allSettled([
			createAppConfigVersion(db, {
				appId: "app-a",
				config: { caller: "first" },
			}),
			createAppConfigVersion(db, {
				appId: "app-a",
				config: { caller: "second" },
			}),
		]);
		expect(results.map((result) => result.status)).toEqual([
			"fulfilled",
			"fulfilled",
		]);
		const rows = results.map((result) => {
			if (result.status === "rejected") throw result.reason;
			return result.value;
		});
		expect(rows.map((row) => row.version).sort((a, b) => a - b)).toEqual([
			1, 2,
		]);
		expect(new Set(rows.map((row) => row.id)).size).toBe(2);
		expect(rows.map((row) => row.config)).toEqual([
			{ caller: "first" },
			{ caller: "second" },
		]);
		expect(await listAppConfigVersions(db, "app-a")).toEqual(
			[...rows].sort((a, b) => b.version - a.version),
		);
		expect(counter(sqlite)).toBe(2);
	});

	it("rejects a missing app without creating a draft or changing another app", async () => {
		const { db, sqlite } = fixture();
		await expect(
			createAppConfigVersion(db, { appId: "missing", config: {} }),
		).rejects.toThrow();
		expect(await listAppConfigVersions(db, "missing")).toEqual([]);
		expect(counter(sqlite)).toBe(0);
	});

	it.each(["insert", "counter"])(
		"rolls back the entire draft when %s fails",
		async (failure) => {
			const { db, sqlite } = fixture();
			const existing = await createAppConfigVersion(db, {
				appId: "app-a",
				config: { original: true },
			});
			const before = sqlite
				.prepare("SELECT * FROM apps WHERE id = 'app-a'")
				.get();
			sqlite.exec(
				failure === "counter"
					? "CREATE TRIGGER fail_draft BEFORE UPDATE OF latest_config_version ON apps BEGIN SELECT RAISE(ABORT, 'injected counter failure'); END"
					: "CREATE TRIGGER fail_draft BEFORE INSERT ON app_config_versions BEGIN SELECT RAISE(ABORT, 'injected insertion failure'); END",
			);
			await expect(
				createAppConfigVersion(db, {
					appId: "app-a",
					config: { failed: true },
				}),
			).rejects.toThrow();
			expect(await listAppConfigVersions(db, "app-a")).toEqual([existing]);
			expect(
				sqlite.prepare("SELECT * FROM apps WHERE id = 'app-a'").get(),
			).toEqual(before);
			sqlite.exec("DROP TRIGGER fail_draft");
			expect(
				(await createAppConfigVersion(db, { appId: "app-a", config: {} }))
					.version,
			).toBe(2);
		},
	);
});
