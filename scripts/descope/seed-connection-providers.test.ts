import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
	parseProviderManifest,
	planProviderReconciliation,
} from "./seed-connection-providers";
const manifest = {
	version: 1,
	providers: [
		{
			id: "example",
			name: "Example",
			description: "Fictional provider",
			icon: "{ASSETS_URL}/example.png",
			category: "development",
			type: "oauth",
			requiredScopes: ["read"],
			supportedScopes: ["user"],
			recommendedScope: "user",
			oauthConfig: {
				authorizationUrl: "https://auth.example/authorize",
				tokenUrl: "https://auth.example/token",
				pkce: true,
			},
		},
	],
};
describe("installation-owned provider manifests", () => {
	test("validates explicit manifests and expands only the configured assets origin", () => {
		const providers = parseProviderManifest(
			JSON.stringify(manifest),
			"https://assets.example",
		);
		expect(providers[0]?.icon).toBe("https://assets.example/example.png");
		expect(() => parseProviderManifest(JSON.stringify(manifest))).toThrow(
			"ASSETS_URL",
		);
		expect(() =>
			parseProviderManifest(
				JSON.stringify({
					...manifest,
					providers: [manifest.providers[0], manifest.providers[0]],
				}),
				"https://assets.example",
			),
		).toThrow("unique");
	});
	test("compare-and-swap refuses concurrent provider edits and insert races", () => {
		const db = new Database(":memory:");
		db.exec(
			"CREATE TABLE connection_providers (id TEXT PRIMARY KEY,name TEXT,description TEXT,icon TEXT,category TEXT,type TEXT,descope_app_id TEXT,descope_app_aliases TEXT,sort_order INTEGER,recommended_scope TEXT,supported_scopes TEXT,required_scopes TEXT,credential_profile TEXT,oauth_config TEXT,created_at TEXT,updated_at TEXT)",
		);
		const providers = parseProviderManifest(
			JSON.stringify(manifest),
			"https://assets.example",
		);
		const initial = planProviderReconciliation(providers, []);
		const insert = initial.changes[0]!;
		expect(db.query(insert.sql).all()).toEqual([{ id: "example" }]);
		expect(db.query(insert.sql).all()).toEqual([]);
		const rows = db
			.query("SELECT * FROM connection_providers")
			.all() as Parameters<typeof planProviderReconciliation>[1];
		const update = planProviderReconciliation(
			[{ ...providers[0]!, name: "New name" }],
			rows,
		);
		expect(planProviderReconciliation(providers, rows).snapshot).not.toBe(
			update.snapshot,
		);
		db.exec("UPDATE connection_providers SET name='Concurrent edit'");
		expect(db.query(update.changes[0]!.sql).all()).toEqual([]);
		const changed = db
			.query("SELECT * FROM connection_providers")
			.all() as Parameters<typeof planProviderReconciliation>[1];
		expect(planProviderReconciliation(providers, changed).snapshot).not.toBe(
			update.snapshot,
		);
		db.close();
	});
});
