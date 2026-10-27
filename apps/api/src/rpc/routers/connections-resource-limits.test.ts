import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { organizations } from "@tedix/db/schema/organizations";
import { apps } from "@tedix/db/schema/apps";
import { appTools } from "@tedix/db/schema";
import * as providers from "@tedix/db/queries/connection-providers";
import { setOrganizationConnectionAllowedResources } from "@tedix/db/queries/connection-instances";
import { connectionsContractRouter } from "./connections";
import { resolveCredentialChain } from "./connections/policy-resolution";
import { userContext, apiKeyContext } from "../test-context";

const databases: DatabaseSync[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const db of databases.splice(0)) db.close();
});
const policy = [
	{ resourceType: "github_repository" as const, resourceId: "example/repo-x" },
];

async function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	databases.push(sqlite);
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(schemaDdl(organizations, apps, appTools));
	const db = createDbClient(createD1Facade(sqlite));
	await db
		.insert(organizations)
		.values({ id: "org-1", name: "Example", slug: "example" });
	await db.insert(apps).values({
		id: "github-app",
		name: "GitHub",
		slug: "github",
		organizationId: "org-1",
	});
	await db.insert(appTools).values({
		id: "tool-update",
		appId: "github-app",
		toolId: "update_issue",
		title: "Update issue",
		toolTypeId: "mcp",
		enabled: true,
		config: {
			transport: "mcp",
			mcpToolName: "issue_write",
			mcpServerUrl: "https://api.githubcopilot.com/mcp/",
			auth: { type: "connection", connectionId: "github" },
		},
		createdAt: "now",
		updatedAt: "now",
	});
	return db;
}

it.each([
	() => userContext({ permissions: ["apps:read"] }),
	() => apiKeyContext({ scopes: ["connections.execute"] }),
])("refuses a consumer changing its own resource policy", async (context) => {
	const client = createRouterClient(connectionsContractRouter, {
		context: context(),
	});
	await expect(
		client.setAllowedResources({
			providerId: "github",
			allowedResources: null,
		}),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
});

it("saves and reads the exact provider limit using the administrator control", async () => {
	const db = await fixture();
	const client = createRouterClient(connectionsContractRouter, {
		context: userContext({
			db,
			permissions: ["integrations:manage", "apps:read"],
		}),
	});
	expect(
		await client.setAllowedResources({
			providerId: "github",
			allowedResources: policy,
		}),
	).toEqual({ allowedResources: policy });
	expect(await client.getAllowedResources({ providerId: "github" })).toEqual({
		allowedResources: policy,
	});
	expect(
		await client.setAllowedResources({
			providerId: "github",
			allowedResources: [],
		}),
	).toEqual({ allowedResources: [] });
});

it("refuses Y and a revoked X approval before provider registration or vault access", async () => {
	const db = await fixture();
	await setOrganizationConnectionAllowedResources(
		db,
		"org-1",
		"github",
		policy,
	);
	const provider = vi.spyOn(providers, "getConnectionProviderByDescopeAppId");
	const network = vi.spyOn(globalThis, "fetch");
	const context = apiKeyContext({
		db,
		scopes: ["connections.execute"],
		headers: { "X-Tedix-Mcp-Tool-Id": "update_issue" },
	});
	const pending = {
		owner: "example",
		repo: "repo-x",
		method: "update",
		issue_number: 1,
		title: "Updated",
	};
	const execute = (
		arguments_: typeof pending,
		scope: "tenant" | "hybrid" = "tenant",
	) =>
		resolveCredentialChain(context, {
			organizationId: "org-1",
			descopeTenantId: "tenant-example",
			providerId: "github",
			scope,
			delegatedToolUse: { appId: "github-app", arguments: arguments_ },
		});
	await expect(execute({ ...pending, repo: "repo-y" })).rejects.toMatchObject({
		code: "FORBIDDEN",
	});
	await expect(
		execute({ ...pending, repo: "repo-y" }, "hybrid"),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	await setOrganizationConnectionAllowedResources(db, "org-1", "github", []);
	await expect(execute(pending)).rejects.toMatchObject({ code: "FORBIDDEN" });
	expect(provider).not.toHaveBeenCalled();
	expect(network).not.toHaveBeenCalled();
});
