import "@orpc/openapi/extensions/route";
import { DatabaseSync } from "node:sqlite";
import { createRouterClient, os } from "@orpc/server";
import * as z from "zod";
import { createDbClient } from "@tedix/db/client";
import { auditEvents } from "@tedix/db/schema/audit-events";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "./orpc";
import { osAudit } from "./os-audit";
import {
	ORGANIZATION_SECRETS_AUDIT,
	ORGANIZATION_SETTINGS_AUDIT,
	ROLE_TEMPLATES_AUDIT,
	WEB_PUSH_AUDIT,
} from "./settings-audit";

const registries = [
	ORGANIZATION_SECRETS_AUDIT,
	ORGANIZATION_SETTINGS_AUDIT,
	ROLE_TEMPLATES_AUDIT,
	WEB_PUSH_AUDIT,
];
const input = {
	organizationId: "org-a",
	secretId: "secret-a",
	keyId: "key-a",
	claimId: "claim-a",
	tediId: "tedi-a",
	memberKey: "provider-a",
	mcpServerId: "server-a",
	value: "PRIVATE-CREDENTIAL",
	endpoint: "PRIVATE-ENDPOINT",
	clientId: "PRIVATE-CLIENT",
};
const output = {
	id: "record-a",
	apiKey: { id: "key-a" },
	claimId: "claim-a",
	enabled: true,
	mode: "eu",
	revision: 2,
	rawKey: "PRIVATE-KEY",
};
function setup() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(schemaDdl(auditEvents));
	const db = createDbClient(createD1Facade(sqlite));
	const context = {
		db,
		organizationId: "org-a",
		authType: "user",
		userId: "person-a",
		user: { sub: "login-a" },
		headers: new Headers(),
		env: {},
	} as BaseContext;
	return { sqlite, db, context };
}
const procedure = os
	.route({ method: "POST" })
	.input(z.unknown())
	.output(z.unknown());

describe("settings audit emission", () => {
	for (const registry of registries)
		for (const path of Object.keys(registry)) {
			it(`records the actor and excludes credentials for ${registry[path] && path}`, async () => {
				const { sqlite, db, context } = setup();
				try {
					const builder = procedure
						.$context<BaseContext>()
						.use(osAudit(registry));
					const client = createRouterClient(
						{ [path]: builder.handler(() => output) },
						{ context },
					);
					await client[path]!(input);
					const rows = await db.select().from(auditEvents);
					expect(rows).toHaveLength(1);
					expect(rows[0]).toMatchObject({
						organizationId: "org-a",
						actorId: "person-a",
						actorType: "user",
					});
					expect(rows[0]!.resourceId).toBeTruthy();
					expect(JSON.stringify(rows)).not.toContain("PRIVATE-");
				} finally {
					sqlite.close();
				}
			});
		}
	it("records verified external agent attribution and the authorized cross-org key target", async () => {
		const { sqlite, db, context } = setup();
		try {
			context.externalAgentPrincipalId = "agent-a";
			context.externalAgentSessionId = "session-a";
			const builder = procedure
				.$context<BaseContext>()
				.use(osAudit(ORGANIZATION_SETTINGS_AUDIT));
			const client = createRouterClient(
				{ createApiKey: builder.handler(() => output) },
				{ context },
			);
			await client.createApiKey({ ...input, organizationId: "org-b" });
			expect((await db.select().from(auditEvents))[0]).toMatchObject({
				organizationId: "org-b",
				actorId: "agent-a",
				actorType: "external_agent",
				metadata: { sessionId: "session-a" },
			});
		} finally {
			sqlite.close();
		}
	});
	it("audits unscoped consent in the verified resource owner's organization", async () => {
		const { sqlite, db, context } = setup();
		try {
			context.organizationId = undefined;
			const builder = procedure
				.$context<BaseContext>()
				.use(osAudit(ORGANIZATION_SETTINGS_AUDIT));
			const client = createRouterClient(
				{ stageMultiOrgMcpConsent: builder.handler(() => output) },
				{ context },
			);
			await client.stageMultiOrgMcpConsent({
				resourceUrl: "https://example.test/mcp",
			});
			expect((await db.select().from(auditEvents))[0]).toMatchObject({
				organizationId: "org-a",
				actorId: "person-a",
				action: "organization.mcp_consent.staged",
			});
		} finally {
			sqlite.close();
		}
	});

	it("emits nothing for a rejected mutation or disabled push subscription", async () => {
		const { sqlite, db, context } = setup();
		try {
			const builder = procedure
				.$context<BaseContext>()
				.use(osAudit(WEB_PUSH_AUDIT));
			const client = createRouterClient(
				{
					subscribe: builder.handler(() => ({ enabled: false })),
					setPreferences: builder.handler(() => {
						throw new Error("denied");
					}),
				},
				{ context },
			);
			await client.subscribe(input);
			await expect(client.setPreferences(input)).rejects.toThrow("denied");
			expect(await db.select().from(auditEvents)).toEqual([]);
		} finally {
			sqlite.close();
		}
	});
});

vi.mock("@tedix/db/queries/mcp-consent", async (original) => ({
	...(await original<typeof import("@tedix/db/queries/mcp-consent")>()),
	getMcpConsentResource: vi.fn(async () => ({ organizationId: "org-a" })),
}));
