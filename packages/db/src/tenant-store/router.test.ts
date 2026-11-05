import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { readTenantStoreMigrationFiles } from "../../scripts/tenant-store-migrations";
import { tenantStoreMigrations } from "./migrations";
import {
	requireWorkspaceScope,
	routeTenantQuery,
	tenantStoreName,
} from "./router";

describe("TenantStore router", () => {
	it("names one object per organization and workspace", () => {
		expect(
			tenantStoreName({ organizationId: "org_a", workspaceId: "ws_1" }),
		).toBe("org_a:ws_1");
		// Encoded parts keep `a:b` + `c` apart from `a` + `b:c`.
		expect(
			tenantStoreName({ organizationId: "a:b", workspaceId: "c" }),
		).not.toBe(tenantStoreName({ organizationId: "a", workspaceId: "b:c" }));
	});

	it("refuses scopes without a workspace", () => {
		expect(() => requireWorkspaceScope({ organizationId: "org_a" })).toThrow(
			"requires workspaceId",
		);
		expect(() =>
			requireWorkspaceScope({ organizationId: " ", workspaceId: "ws" }),
		).toThrow("requires organizationId");
	});

	it("hands the query the stub for idFromName(org:workspace) and a clean scope", () => {
		const names: string[] = [];
		const namespace = {
			idFromName: (name: string) => {
				names.push(name);
				return name;
			},
			get: (id: string) => ({ id }),
		} as unknown as DurableObjectNamespace;
		const result = routeTenantQuery(
			namespace,
			{ organizationId: "org_a", workspaceId: "ws_1", extra: true } as never,
			(store, scope) => ({ store, scope }),
		);
		expect(names).toEqual(["org_a:ws_1"]);
		expect(result).toEqual({
			store: { id: "org_a:ws_1" },
			scope: { organizationId: "org_a", workspaceId: "ws_1" },
		});
	});
});

describe("TenantStore migrations module", () => {
	it("matches tenant-store-drizzle", () => {
		const dir = fileURLToPath(
			new URL("../../tenant-store-drizzle", import.meta.url),
		);
		expect(tenantStoreMigrations).toEqual(readTenantStoreMigrationFiles(dir));
	});
});
