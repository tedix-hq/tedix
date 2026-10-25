import type { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { getPluginInstall } from "@tedix/db/queries/plugins";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { createMigratedSqlite } from "@tedix/db/test/migrated-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { pluginsContractRouter } from "./plugins";

describe("plugin activation organization boundary", () => {
	let sqlite: DatabaseSync;
	let db: BaseContext["db"];
	let client: ReturnType<
		typeof createRouterClient<typeof pluginsContractRouter>
	>;

	beforeEach(() => {
		sqlite = createMigratedSqlite();
		sqlite.exec(`
			INSERT INTO organizations(id, name, slug) VALUES
				('org-a', 'Example A', 'example-a'),
				('org-b', 'Example B', 'example-b');
			INSERT INTO tedis(id, organization_id, name, slug) VALUES
				('tedi-a', 'org-a', 'Example A', 'example-a'),
				('tedi-b', 'org-b', 'Example B', 'example-b');
			INSERT INTO tedi_plugins(id, slug, name, type, version) VALUES
				('plugin', 'example', 'Example', 'tool', '1.0.0');
			INSERT INTO tedi_plugin_installs(id, org_id, plugin_id, status, updated_at) VALUES
				('install-a', 'org-a', 'plugin', 'installed', '2026-01-01T00:00:00.000Z'),
				('install-b', 'org-b', 'plugin', 'installed', '2026-01-01T00:00:00.000Z');
		`);
		db = createDbClient(createD1Facade(sqlite));
		client = createRouterClient(pluginsContractRouter, {
			context: {
				db,
				env: {},
				headers: new Headers(),
				organizationId: "org-a",
				authType: "user",
				user: { sub: "example-user", permissions: ["integrations:manage"] },
				url: new URL("https://api.example.test/rpc/plugins/activate"),
			} as BaseContext,
		});
	});

	afterEach(() => sqlite.close());

	it.each(["tedi-b", "missing-tedi"])(
		"rejects out-of-organization or missing tedi %s without modifying the install",
		async (tediId) => {
			const before = await getPluginInstall(db, "install-a", "org-a");
			await expect(
				client.activate({ installId: "install-a", tediId }),
			).rejects.toMatchObject({ code: "NOT_FOUND", message: "Tedi not found" });
			expect(await getPluginInstall(db, "install-a", "org-a")).toEqual(before);
		},
	);

	it("activates a tedi in the install organization", async () => {
		await expect(
			client.activate({ installId: "install-a", tediId: "tedi-a" }),
		).resolves.toMatchObject({
			id: "install-a",
			orgId: "org-a",
			tediId: "tedi-a",
			status: "active",
		});
		expect(await getPluginInstall(db, "install-a", "org-a")).toMatchObject({
			tediId: "tedi-a",
			status: "active",
		});
	});

	it("rejects an install from another organization without modifying it", async () => {
		const before = await getPluginInstall(db, "install-b", "org-b");
		await expect(
			client.activate({ installId: "install-b", tediId: "tedi-a" }),
		).rejects.toMatchObject({
			code: "NOT_FOUND",
			message: "Installation not found",
		});
		expect(await getPluginInstall(db, "install-b", "org-b")).toEqual(before);
	});
});
