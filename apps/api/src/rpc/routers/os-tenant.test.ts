/**
 * OS tenant resolution: service-binding-only access and the explicit
 * `features.os` provisioning gate.
 */

import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { organizations } from "@tedix/db/schema";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { osTenantContractRouter } from "./os-tenant";

let sqlite: DatabaseSync;

function context(serviceBinding: boolean): BaseContext {
	const headers = new Headers();
	if (serviceBinding) {
		headers.set("X-Service-Binding", "true");
		headers.set("X-Service-Binding", "true");
	}
	return {
		authType: "none",
		db: createDbClient(createD1Facade(sqlite)) as BaseContext["db"],
		env: { ENVIRONMENT: "test" } as CloudflareEnv,
		headers,
		url: new URL("https://api/rpc/osTenant/resolve"),
	} as BaseContext;
}

function seedOrganization(slug: string, features: string | null) {
	sqlite
		.prepare(
			`INSERT INTO organizations (id, name, slug, features)
				VALUES (?, ?, ?, ?)`,
		)
		.run(`org-${slug}`, slug, slug, features);
}

describe("osTenant.resolve", () => {
	beforeEach(() => {
		sqlite = new DatabaseSync(":memory:");
		sqlite.exec("PRAGMA foreign_keys = OFF;");
		sqlite.exec(schemaDdl(organizations));
	});

	it("refuses anything that is not a service-binding call", async () => {
		const client = createRouterClient(osTenantContractRouter, {
			context: context(false),
		});
		await expect(client.resolve({ slug: "tedix" })).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
	});

	it("resolves only organizations with the explicit os feature", async () => {
		seedOrganization("provisioned", JSON.stringify({ os: true }));
		seedOrganization("unflagged", JSON.stringify({ sso: true }));
		seedOrganization("nofeatures", null);
		const client = createRouterClient(osTenantContractRouter, {
			context: context(true),
		});

		await expect(client.resolve({ slug: "provisioned" })).resolves.toEqual({
			provisioned: true,
			organizationId: "org-provisioned",
			descopeTenantId: null,
		});
		await expect(client.resolve({ slug: "unflagged" })).resolves.toEqual({
			provisioned: false,
			organizationId: null,
			descopeTenantId: null,
		});
		await expect(client.resolve({ slug: "nofeatures" })).resolves.toEqual({
			provisioned: false,
			organizationId: null,
			descopeTenantId: null,
		});
		await expect(client.resolve({ slug: "missing" })).resolves.toEqual({
			provisioned: false,
			organizationId: null,
			descopeTenantId: null,
		});
	});
});
