import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDialect } from "emdash/db/sqlite";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("virtual:emdash/config", () => ({ default: {} }));
vi.mock("virtual:emdash/seed", () => ({
	seed: {
		version: "1",
		settings: {},
		collections: [
			{
				slug: "pages",
				label: "Pages",
				fields: [{ slug: "title", label: "Title", type: "string" }],
			},
		],
		blockTypes: [
			{
				slug: "test_prose",
				label: "Test prose",
				currentVersion: 1,
				versions: [
					{
						version: 1,
						fields: [{ slug: "text", label: "Text", type: "string" }],
					},
				],
			},
		],
	},
	userSeed: null,
}));

// The runtime is internal to Emdash; exercise the exact bundled file shipped
// by each template instead of its unbundled source dependencies.
// @ts-expect-error Emdash does not publish declarations for its internal chunk.
import { n as TedixEmDashRuntime } from "../templates/tedix/node_modules/emdash/dist/emdash-runtime-BlybX9Ui.mjs";
// @ts-expect-error Emdash does not publish declarations for its internal chunk.
import { n as MarketingEmDashRuntime } from "../templates/marketing/node_modules/emdash/dist/emdash-runtime-BlybX9Ui.mjs";

describe.each([
	["tedix", TedixEmDashRuntime],
	["marketing", MarketingEmDashRuntime],
])("Emdash %s auto-seed during site transfer", (_template, EmDashRuntime) => {
	type Runtime = InstanceType<typeof TedixEmDashRuntime>;
	const runtimes: Runtime[] = [];
	let db: Runtime["db"] | undefined;
	let testDir: string | undefined;

	afterEach(async () => {
		for (const runtime of runtimes) {
			await runtime.stopCron();
			await runtime.db.destroy();
		}
		runtimes.length = 0;
		if (testDir) await rm(testDir, { recursive: true, force: true });
		db = undefined;
		testDir = undefined;
	});

	it("seeds a fresh site, but cannot restore scaffold after an import takes the write fence", async () => {
		testDir = await mkdtemp(join(tmpdir(), "tedix-emdash-seed-fence-"));
		const url = `file:${join(testDir, "site.db")}`;
		const makeRuntime = async () => {
			const runtime = await EmDashRuntime.create({
				config: {
					database: {
						entrypoint: `transfer-seed-${randomUUID()}`,
						config: { url },
						type: "sqlite",
					},
				},
				plugins: [],
				createDialect: () => createDialect({ url }),
				createStorage: null,
				sandboxEnabled: false,
				sandboxedPluginEntries: [],
				createSandboxRunner: null,
			});
			runtimes.push(runtime);
			return runtime;
		};

		const fresh = await makeRuntime();
		db = fresh.db;
		expect(
			await db.selectFrom("_emdash_block_types").select("slug").execute(),
		).toEqual([{ slug: "test_prose" }]);
		expect(
			await db
				.selectFrom("options")
				.select("value")
				.where("name", "=", "emdash:seed_complete")
				.executeTakeFirst(),
		).toEqual({ value: "true" });

		// Reproduce an older site's missing ownership marker while the importer
		// has removed the seeded schema and fenced all site writes.
		await db.deleteFrom("_emdash_block_type_versions").execute();
		await db.deleteFrom("_emdash_block_types").execute();
		await db.deleteFrom("_emdash_fields").execute();
		await db.deleteFrom("_emdash_collections").execute();
		await db
			.deleteFrom("options")
			.where("name", "=", "emdash:seed_complete")
			.execute();
		const importId = randomUUID();
		await db
			.insertInto("_emdash_transfer_operations")
			.values({
				id: importId,
				kind: "import",
				state: "running",
				staging_secret: "test-secret",
				created_by: "test",
			})
			.execute();

		await makeRuntime();
		expect(
			await db.selectFrom("_emdash_block_types").select("slug").execute(),
		).toEqual([]);
		expect(
			await db
				.selectFrom("options")
				.select("value")
				.where("name", "=", "emdash:seed_complete")
				.executeTakeFirst(),
		).toBeUndefined();

		// Import reserve claims the site's seed ownership before completion.
		await db
			.insertInto("options")
			.values({ name: "emdash:seed_complete", value: "true" })
			.execute();
		await db
			.updateTable("_emdash_transfer_operations")
			.set({ state: "completed" })
			.where("id", "=", importId)
			.execute();
		await makeRuntime();
		expect(
			await db.selectFrom("_emdash_block_types").select("slug").execute(),
		).toEqual([]);
	});
});
