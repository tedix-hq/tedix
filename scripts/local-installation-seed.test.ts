import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { WorkOnboardingSchema } from "@tedix/api-contract/schemas/work-onboarding";
import { ModelCatalogConfigSchema } from "@tedix/api-contract/schemas/model-catalog-config";
import {
	LOCAL_WORKERS_AI_MODEL_REF,
	localInstallationSeedSql,
} from "./local-installation-seed";

test("a fresh local installation has a published Work definition without creating any tenant state", () => {
	const db = new Database(":memory:");
	db.exec(
		"CREATE TABLE policy_packs(id TEXT,organization_id TEXT,name TEXT,slug TEXT,scope TEXT,target TEXT,status TEXT,version INTEGER,published_at TEXT,published_by TEXT,definition TEXT)",
	);
	db.exec(localInstallationSeedSql());
	const row = db.query("SELECT * FROM policy_packs").get() as Record<
		string,
		unknown
	>;
	expect(row).toMatchObject({
		organization_id: null,
		slug: "work-onboarding",
		scope: "system",
		target: "shared",
		status: "active",
		version: 1,
		published_by: "local-development",
	});
	expect(
		WorkOnboardingSchema.parse(
			JSON.parse(row.definition as string).workOnboarding,
		).definition.gadgets,
	).toHaveLength(2);
	db.exec(localInstallationSeedSql());
	expect(db.query("SELECT count(*) AS n FROM policy_packs").get()).toEqual({
		n: 1,
	});
	db.exec("UPDATE policy_packs SET status='archived',definition='{}'");
	db.exec(localInstallationSeedSql());
	expect(db.query("SELECT status,definition FROM policy_packs").get()).toEqual({
		status: "archived",
		definition: "{}",
	});
	db.close();
});

test("with Workers AI on, local chat gets a one-model catalog it can route through", () => {
	const db = new Database(":memory:");
	db.exec(
		"CREATE TABLE policy_packs(id TEXT,organization_id TEXT,name TEXT,slug TEXT,scope TEXT,target TEXT,status TEXT,version INTEGER,published_at TEXT,published_by TEXT,definition TEXT)",
	);
	db.exec(localInstallationSeedSql());
	expect(db.query("SELECT slug FROM policy_packs ORDER BY slug").all()).toEqual(
		[{ slug: "work-onboarding" }],
	);
	db.exec(localInstallationSeedSql({ workersAi: true }));
	db.exec(localInstallationSeedSql({ workersAi: true }));
	const row = db
		.query("SELECT * FROM policy_packs WHERE slug='model-catalog'")
		.all() as Record<string, unknown>[];
	expect(row).toHaveLength(1);
	expect(row[0]).toMatchObject({ scope: "system", status: "active" });
	const catalog = ModelCatalogConfigSchema.parse(
		JSON.parse(row[0]!.definition as string).modelCatalog,
	);
	expect(catalog.entries.map((entry) => entry.ref)).toEqual([
		LOCAL_WORKERS_AI_MODEL_REF,
	]);
	expect(catalog.defaults).toEqual({
		kernelRouteModelRef: LOCAL_WORKERS_AI_MODEL_REF,
		workersAiModelRef: LOCAL_WORKERS_AI_MODEL_REF,
	});
	db.close();
});
