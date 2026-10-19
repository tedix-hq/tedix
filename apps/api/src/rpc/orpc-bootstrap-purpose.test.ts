import { DatabaseSync } from "node:sqlite";
import { call, createRouterClient, os } from "@orpc/server";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { createDbClient } from "@tedix/db/client";
import { createApiKey } from "@tedix/db/queries/api-keys";
import { apiKeys } from "@tedix/db/schema/api-keys";
import * as agentTables from "@tedix/db/schema/external-agent-identity";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { tableDdl } from "@tedix/db/test/schema-ddl";
import { type BaseContext, withAuth } from "./orpc";
import { externalAgentIdentityContractRouter } from "./routers/external-agent-identity";
import { workItemsContractRouter } from "./routers/work-items";

const ORG = "00000000-0000-4000-8000-000000000001";
const PRINCIPAL = "00000000-0000-4000-8000-000000000002";
let sqlite: DatabaseSync;
let db: ReturnType<typeof createDbClient>;
let pending: Promise<unknown>[];
beforeEach(() => {
	sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(
		[apiKeys, ...Object.values(agentTables)].flatMap(tableDdl).join(";"),
	);
	db = createDbClient(createD1Facade(sqlite));
	pending = [];
});
afterEach(async () => {
	await Promise.all(pending);
	sqlite.close();
});
function context(rawKey: string, path: string, trusted = false): BaseContext {
	return {
		db,
		env: { ENVIRONMENT: "test" } as CloudflareEnv,
		headers: new Headers({
			"X-API-Key": rawKey,
			...(trusted
				? {
						"X-Service-Binding": "true",
						"X-Tedix-Caller-Type": "mcp-edge-external-agent-session-exchange",
					}
				: {}),
		}),
		url: new URL(`https://api${path}`),
		waitUntil: (promise) => {
			pending.push(promise);
		},
	} as BaseContext;
}
async function bootstrap() {
	return createApiKey(db, {
		organizationId: ORG,
		name: "Cloud bootstrap",
		purpose: "external_agent_bootstrap",
		expiresAt: "2099-01-01T00:00:00.000Z",
	});
}

describe("bootstrap credential ingress", () => {
	it("returns 403 on the real Work list REST handler", async () => {
		const { rawKey } = await bootstrap();
		const ctx = context(rawKey, "/v1/work-items");
		const handler = new OpenAPIHandler({ workItems: workItemsContractRouter });
		const result = await handler.handle(
			new Request(ctx.url, { headers: ctx.headers }),
			{ prefix: "/v1", context: ctx },
		);
		expect(result.matched).toBe(true);
		expect(result.response?.status).toBe(403);
		expect(await result.response?.text()).toContain("Bootstrap credential");
	});
	it("authenticates that same key on the actual trusted openSession handler", async () => {
		const { rawKey, apiKey } = await bootstrap();
		await db.insert(agentTables.externalAgentPrincipals).values({
			id: PRINCIPAL,
			organizationId: ORG,
			key: "cloud-fixture",
			displayName: "Cloud fixture",
			status: "active",
			credentialBindingType: "api_key",
			credentialBindingId: apiKey.id,
			createdByType: "user",
			createdById: "fixture-owner",
			metadata: { platform: "codex-cloud", allowedScopes: ["mcp:work.read"] },
		});
		const denied = context(rawKey, "/rpc/externalAgentIdentity/openSession");
		const input = {
			organizationId: ORG,
			principalId: PRINCIPAL,
			externalSessionKey: "codex:fixture",
			harness: "codex",
			harnessVersion: "1",
			modelProvider: "fixture",
			modelId: "fixture",
			modelVersion: "1",
		};
		await expect(
			createRouterClient(externalAgentIdentityContractRouter, {
				context: denied,
			}).openSession(input),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		const allowed = context(
			rawKey,
			"/rpc/externalAgentIdentity/openSession",
			true,
		);
		const session = await createRouterClient(
			externalAgentIdentityContractRouter,
			{ context: allowed },
		).openSession(input);
		expect(session.principalId).toBe(PRINCIPAL);
		expect(allowed.apiKey).toMatchObject({
			id: apiKey.id,
			purpose: "external_agent_bootstrap",
			scopes: [],
		});
		expect(allowed.user).toBeUndefined();
	});
	it("does not accept a caller marker without a trusted service binding", async () => {
		const { rawKey } = await bootstrap();
		const ctx = context(
			rawKey,
			"/rpc/externalAgentIdentity/issueMcpCredential",
		);
		ctx.headers.set(
			"X-Tedix-Caller-Type",
			"mcp-edge-external-agent-session-exchange",
		);
		const guarded = os
			.$context<BaseContext>()
			.use(withAuth)
			.handler(() => "must not run");
		await expect(
			call(guarded, undefined, { context: ctx }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
	it("covers already-authenticated keys and retains general API key behavior", async () => {
		const guarded = os
			.$context<BaseContext>()
			.use(withAuth)
			.handler(({ context }) => context.apiKey?.purpose);
		const { rawKey, apiKey } = await bootstrap();
		const cached = context(rawKey, "/rpc/workItems/list");
		cached.apiKey = {
			id: apiKey.id,
			organizationId: ORG,
			name: apiKey.name,
			purpose: "external_agent_bootstrap",
			scopes: ["*"],
		};
		await expect(
			call(guarded, undefined, { context: cached }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		const general = await createApiKey(db, {
			organizationId: ORG,
			name: "Existing integration",
		});
		await expect(
			call(guarded, undefined, {
				context: context(general.rawKey, "/rpc/workItems/list"),
			}),
		).resolves.toBe("general");
	});
});
