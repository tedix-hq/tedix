/**
 * OS tenant resolution: service-binding-only access and the explicit
 * `features.os` provisioning gate.
 */

import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { organizations, cmsDomainClaims } from "@tedix/db/schema";
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

describe("osTenant.resolveHostname", () => {
	beforeEach(() => {
		sqlite = new DatabaseSync(":memory:");
		sqlite.exec(schemaDdl(organizations, cmsDomainClaims));
		sqlite.exec("CREATE TABLE cms_sites (id TEXT PRIMARY KEY)");
		seedOrganization("alpha", JSON.stringify({ os: true }));
		sqlite.exec(
			`INSERT INTO cms_domain_claims (id,organization_id,hostname,kind,verification_token,provider_hostname_id,status,expires_at,created_at,updated_at) VALUES ('domain','org-alpha','share.example.com','organization','proof','provider','active','2027-01-01','2026-01-01','2026-01-01');`,
		);
	});
	it("requires service authentication and re-reads claim removal on every lookup", async () => {
		const api = createRouterClient(osTenantContractRouter, {
			context: context(true),
		});
		await expect(
			createRouterClient(osTenantContractRouter, {
				context: context(false),
			}).resolveHostname({ hostname: "share.example.com" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(
			await api.resolveHostname({ hostname: "share.example.com" }),
		).toMatchObject({
			provisioned: true,
			organizationId: "org-alpha",
			slug: "alpha",
		});
		sqlite.exec("UPDATE cms_domain_claims SET status='removing'");
		expect(
			await api.resolveHostname({ hostname: "share.example.com" }),
		).toMatchObject({ provisioned: false, organizationId: null, slug: null });
	});
});
