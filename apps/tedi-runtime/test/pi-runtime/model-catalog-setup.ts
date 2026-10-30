import { env } from "cloudflare:workers";
import { beforeAll } from "vite-plus/test";
import {
	modelCatalogConfig,
	modelCatalogEntry,
} from "@tedix/api-contract/test/model-catalog";

// Isolated Worker fixtures use scripted adapters, but exercise the real D1
// publication reader when configuring native facets. No deployed model roster.
beforeAll(async () => {
	const db = (env as unknown as { DB: D1Database }).DB;
	await db
		.prepare(`CREATE TABLE IF NOT EXISTS policy_packs (
 id TEXT PRIMARY KEY, organization_id TEXT, slug TEXT, scope TEXT, target TEXT,
 status TEXT, version INTEGER, published_at TEXT, published_by TEXT, definition TEXT
 )`)
		.run();
	const modelCatalog = modelCatalogConfig([
		modelCatalogEntry("workers-ai/@cf/example/scripted"),
		modelCatalogEntry("azure-openai/gpt-5.6-terra"),
	]);
	await db
		.prepare(`INSERT OR REPLACE INTO policy_packs
 (id,slug,scope,target,status,version,published_at,published_by,definition)
 VALUES (?,?,?,?,?,?,?,?,?)`)
		.bind(
			"fixture-model-catalog",
			"model-catalog",
			"system",
			"shared",
			"active",
			1,
			"2026-01-01T00:00:00Z",
			"fixture-admin",
			JSON.stringify({ modelCatalog }),
		)
		.run();
});
