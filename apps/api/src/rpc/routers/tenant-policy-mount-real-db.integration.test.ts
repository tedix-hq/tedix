import { DatabaseSync } from "node:sqlite";
import { RPCHandler } from "@orpc/server/fetch";
import { createDbClient } from "@tedix/db/client";
import { organizations } from "@tedix/db/schema/organizations";
import { apps } from "@tedix/db/schema/apps";
import { appTools, appToolCspDomains } from "@tedix/db/schema";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it } from "vite-plus/test";
import { prepareTenantIdentityProfileMount } from "../../../../mcp/src/mcp/tenant-policy-mount";
import { appsContractRouter } from "./apps";

describe("fresh gateway mount over the real API and D1", () => {
	it("resolves its mounted source from tenant-owned persisted rows", async () => {
		const sqlite = new DatabaseSync(":memory:");
		try {
			sqlite.exec("PRAGMA foreign_keys = OFF");
			sqlite.exec(schemaDdl(organizations, apps, appTools, appToolCspDomains));
			const db = createDbClient(createD1Facade(sqlite));
			await db
				.insert(organizations)
				.values({ id: "fictional-org", name: "Example", slug: "example" });
			await db.insert(apps).values({
				id: "00000000-0000-4000-8000-000000000001",
				organizationId: "fictional-org",
				name: "Example",
				slug: "example",
			});
			await db.insert(appTools).values({
				id: "row",
				appId: "00000000-0000-4000-8000-000000000001",
				toolTypeId: "mcp",
				toolId: "write",
				title: "Write",
				enabled: true,
				config: {
					transport: "mcp",
					mcpServerUrl: "https://fictional.example.invalid/mcp",
					mcpToolName: "write",
					auth: {
						type: "connection",
						connectionId: "fictional-provider",
						credentialScope: "user",
					},
				},
			});
			const handler = new RPCHandler({ apps: appsContractRouter });
			const env = {
				ENVIRONMENT: "test",
				API_SERVICE: {
					fetch: async (request: Request) => {
						const { response } = await handler.handle(request, {
							prefix: "/rpc",
							context: {
								authType: "service-binding",
								organizationId: "fictional-org",
								db,
								env: { ENVIRONMENT: "test" },
								headers: request.headers,
								url: new URL(request.url),
							} as never,
						});
						return response ?? new Response("missing", { status: 404 });
					},
				},
			} as unknown as CloudflareEnv;
			const result = await prepareTenantIdentityProfileMount({
				organizationId: "fictional-org",
				rootAppId: "00000000-0000-4000-8000-000000000001",
				mountedToolId: "example__write",
				env,
			});
			expect(result?.descriptor).toMatchObject({
				organizationId: "fictional-org",
				sourceToolRowId: "row",
				upstreamOperation: "write",
			});
		} finally {
			sqlite.close();
		}
	});
});
