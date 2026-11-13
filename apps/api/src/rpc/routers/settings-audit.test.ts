import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { auditEvents } from "@tedix/db/schema/audit-events";
import { apiKeys } from "@tedix/db/schema/api-keys";
import { organizationSecrets } from "@tedix/db/schema/organization-secrets";
import { organizations } from "@tedix/db/schema/organizations";
import { roleTemplates } from "@tedix/db/schema";
import { userConfigs } from "@tedix/db/schema/user-configs";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it, vi } from "vite-plus/test";
import { userContext } from "../test-context";
import { organizationSecretsContractRouter } from "./organization-secrets";
import {
	createApiKeyContract,
	revokeApiKeyContract,
	deleteApiKeyContract,
} from "./organizations-api-keys";
import { roleTemplatesContractRouter } from "./role-templates";
import { webPushRouter } from "./web-push";
import {
	disableMcpAuthorizationContract,
	stageHumanMcpConsentContract,
	revokeHumanMcpConsentContract,
} from "./organizations-mcp-authorizations";
const revision = "00000000-0000-4000-8000-000000000099";
vi.mock("../../lib/mcp-grant", () => ({
	disableHumanMcpAuthorization: vi.fn(
		async () => "00000000-0000-4000-8000-000000000099",
	),
	stageHumanMcpConsent: vi.fn(
		async () => "00000000-0000-4000-8000-000000000099",
	),
	revokeHumanMcpConsent: vi.fn(
		async () => "00000000-0000-4000-8000-000000000099",
	),
}));
const org = "00000000-0000-4000-8000-000000000001";

describe("settings routers persist actor audit rows", () => {
	it("audits real secret, API key, role and push writes and human consent changes", async () => {
		const sqlite = new DatabaseSync(":memory:");
		try {
			sqlite.exec("PRAGMA foreign_keys = OFF");
			sqlite.exec(
				schemaDdl(
					auditEvents,
					apiKeys,
					organizationSecrets,
					organizations,
					roleTemplates,
					userConfigs,
				),
			);
			const db = createDbClient(createD1Facade(sqlite));
			await db
				.insert(organizations)
				.values({ id: org, name: "Example", slug: "example" });
			const context = userContext({
				db,
				organizationId: org,
				userId: "person-a",
				userRole: "owner",
				roles: ["owner"],
				permissions: ["settings:manage", "secrets:manage", "os:read"],
				env: {
					ENVIRONMENT: "test",
					SECRETS_MASTER_KEY: "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=",
				} as unknown as CloudflareEnv,
			});
			const secrets = createRouterClient(organizationSecretsContractRouter, {
				context,
			});
			const secret = await secrets.set({
				organizationId: org,
				name: "EXAMPLE_KEY",
				value: "PRIVATE-CREDENTIAL",
			});
			await secrets.delete({ organizationId: org, secretId: secret.id });
			const keyClient = createRouterClient(
				{
					createApiKey: createApiKeyContract,
					revokeApiKey: revokeApiKeyContract,
					deleteApiKey: deleteApiKeyContract,
				},
				{ context },
			);
			const key = await keyClient.createApiKey({
				organizationId: org,
				name: "Example",
				scopes: ["apps:read"],
			});
			await keyClient.revokeApiKey({
				organizationId: org,
				keyId: key.apiKey.id,
			});
			await keyClient.deleteApiKey({
				organizationId: org,
				keyId: key.apiKey.id,
			});
			await createRouterClient(roleTemplatesContractRouter, { context }).create(
				{
					organizationId: org,
					key: "example",
					name: "Example",
					persona: "PRIVATE-PERSONA",
				},
			);
			await createRouterClient(webPushRouter, { context }).setPreferences({
				mutedProjectIds: [],
			});
			const consent = createRouterClient(
				{
					disableMcpAuthorization: disableMcpAuthorizationContract,
					stageMultiOrgMcpConsent: stageHumanMcpConsentContract,
					revokeMultiOrgMcpConsent: revokeHumanMcpConsentContract,
				},
				{ context },
			);
			await consent.disableMcpAuthorization({
				mcpServerId: "server-a",
				clientId: "client-a",
				expectedRevision: revision,
			});
			await consent.stageMultiOrgMcpConsent({
				resourceUrl: "https://example.test/mcp",
				clientId: "client-a",
				selectedTenantIds: [org],
				approvedScopes: ["mcp:apps.read"],
			});
			await consent.revokeMultiOrgMcpConsent({
				resourceUrl: "https://example.test/mcp",
				clientId: "client-a",
			});
			const rows = await db.select().from(auditEvents);
			expect(rows.map((row) => row.action).sort()).toEqual(
				[
					"organization.secret.set",
					"organization.secret.deleted",
					"organization.api_key.created",
					"organization.api_key.revoked",
					"organization.api_key.deleted",
					"organization.role_template.created",
					"organization.web_push.preferences_set",
					"organization.mcp_authorization.disabled",
					"organization.mcp_consent.staged",
					"organization.mcp_consent.revoked",
				].sort(),
			);
			for (const row of rows)
				expect(row).toMatchObject({
					actorType: "user",
					actorId: "person-a",
					organizationId: org,
				});
			expect(JSON.stringify(rows)).not.toContain("PRIVATE-");
			expect(JSON.stringify(rows)).not.toContain(key.rawKey);
		} finally {
			sqlite.close();
		}
	});
});

vi.mock("@tedix/db/queries/mcp-consent", async (original) => ({
	...(await original<typeof import("@tedix/db/queries/mcp-consent")>()),
	getMcpConsentResource: vi.fn(async () => ({
		organizationId: "00000000-0000-4000-8000-000000000001",
	})),
}));
