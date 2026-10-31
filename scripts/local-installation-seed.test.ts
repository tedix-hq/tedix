import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { WorkOnboardingSchema } from "@tedix/api-contract/schemas/work-onboarding";
import { localInstallationSeedSql } from "./local-installation-seed";

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
