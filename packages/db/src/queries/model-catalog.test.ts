import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import {
	modelCatalogConfig,
	modelCatalogEntry,
} from "@tedix/api-contract/test/model-catalog";
import { createDbClient } from "../client";
import { policyPacks } from "../schema/control-plane";
import { organizations } from "../schema/organizations";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { invalidateSystemPolicySnapshot } from "./control-plane/system-policy";
import { getModelCatalogConfig } from "./model-catalog";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(schemaDdl(organizations, policyPacks));
	const db = createDbClient(createD1Facade(sqlite));
	const config = modelCatalogConfig([
		modelCatalogEntry("azure-openai/example-custom"),
	]);
	const publish = async (
		version: number,
		status = "active",
		definition: unknown = { modelCatalog: config },
	) => {
		await db.insert(policyPacks).values({
			id: `catalog-${version}`,
			name: "Example catalog",
			slug: "model-catalog",
			scope: "system",
			target: "shared",
			status: status as "active",
			version,
			publishedAt: "2026-01-01T00:00:00Z",
			publishedBy: "example-admin",
			definition: definition as never,
		});
		invalidateSystemPolicySnapshot(db);
	};
	return { sqlite, db, config, publish };
}
describe("published model registry", () => {
	it("requires bootstrap and loads the published system snapshot", async () => {
		const f = fixture();
		await expect(getModelCatalogConfig(f.db)).rejects.toThrow();
		await f.publish(1);
		expect(await getModelCatalogConfig(f.db)).toEqual(f.config);
	});
	it.each(["archived", "draft"])(
		"does not restore older authority behind a %s newest head",
		async (status) => {
			const f = fixture();
			await f.publish(1);
			await f.publish(2, status);
			await expect(getModelCatalogConfig(f.db)).rejects.toThrow();
		},
	);
	it("rejects malformed newest configuration instead of using an older valid version", async () => {
		const f = fixture();
		await f.publish(1);
		await f.publish(2, "active", { modelCatalog: { version: 1, entries: [] } });
		await expect(getModelCatalogConfig(f.db)).rejects.toThrow();
	});
	it("rejects tenant-owned or unpublished rows", async () => {
		const f = fixture();
		await f.publish(1);
		await f.db
			.insert(organizations)
			.values({ id: "example-org", name: "Example", slug: "example" });
		f.sqlite.exec("UPDATE policy_packs SET organization_id='example-org'");
		invalidateSystemPolicySnapshot(f.db);
		await expect(getModelCatalogConfig(f.db)).rejects.toThrow();
		f.sqlite.exec(
			"UPDATE policy_packs SET organization_id=NULL,published_by=NULL",
		);
		invalidateSystemPolicySnapshot(f.db);
		await expect(getModelCatalogConfig(f.db)).rejects.toThrow();
	});
});
