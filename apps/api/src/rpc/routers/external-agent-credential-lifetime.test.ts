import { verifyExchangedToken } from "@tedix/auth/token-exchange";
import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import { createDbClient } from "@tedix/db/client";
import { createApiKey } from "@tedix/db/queries/api-keys";
import { resolveAuthorizedExternalAgentMcpSession } from "@tedix/db/queries/external-agent-identity/mcp-credentials";
import { apiKeys } from "@tedix/db/schema/api-keys";
import * as agentTables from "@tedix/db/schema/external-agent-identity";
import { principalIdentities } from "@tedix/db/schema/principal-identities";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { tableDdl } from "@tedix/db/test/schema-ddl";
import type { BaseContext } from "../orpc";

const mocks = vi.hoisted(() => ({
	create: vi.fn(),
	remove: vi.fn(),
	load: vi.fn(),
	search: vi.fn(),
	secret: vi.fn(),
}));
vi.mock("@tedix/auth/aih-client", async (load) => ({
	...(await load<typeof import("@tedix/auth/aih-client")>()),
	createDescopeMcpServerClient: mocks.create,
	deleteDescopeMcpServerClient: mocks.remove,
	loadDescopeMcpServer: mocks.load,
	searchDescopeMcpServerClients: mocks.search,
	getDescopeMcpServerClientSecret: mocks.secret,
}));
import { externalAgentIdentityContractRouter } from "./external-agent-identity";
import {
	forgetMcpServerClients,
	forgetMcpServerRegistrations,
} from "../../lib/provider-facts-cache";
const ORG = "00000000-0000-4000-8000-000000000001";
const PRINCIPAL = "00000000-0000-4000-8000-000000000002";
const SESSION = "00000000-0000-4000-8000-000000000003";
const NOW = "2030-01-01T00:00:00.000Z";
const DEADLINE = "2030-01-01T00:02:00.000Z";
const INPUT = {
	organizationId: ORG,
	principalId: PRINCIPAL,
	sessionId: SESSION,
	scopes: ["mcp:work.read"],
	mcpServerUrl: "https://example.mcp.tedix.dev/mcp",
};
let sqlite: DatabaseSync;
let db: ReturnType<typeof createDbClient>;
let rawKey: string;
let keyId: string;
let pending: Promise<unknown>[];
beforeEach(async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(NOW));
	vi.clearAllMocks();
	forgetMcpServerRegistrations();
	forgetMcpServerClients();
	sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(
		[apiKeys, principalIdentities, ...Object.values(agentTables)]
			.flatMap(tableDdl)
			.join(";"),
	);
	db = createDbClient(createD1Facade(sqlite));
	pending = [];
	const key = await createApiKey(db, {
		organizationId: ORG,
		name: "Fixture bootstrap",
		purpose: "external_agent_bootstrap",
		expiresAt: DEADLINE,
	});
	rawKey = key.rawKey;
	keyId = key.apiKey.id;
	await db.insert(agentTables.externalAgentPrincipals).values({
		id: PRINCIPAL,
		organizationId: ORG,
		key: "fixture-cloud",
		displayName: "Cloud fixture",
		status: "active",
		credentialBindingType: "api_key",
		credentialBindingId: keyId,
		createdByType: "user",
		createdById: "fixture-owner",
		metadata: { platform: "codex-cloud", allowedScopes: ["mcp:work.read"] },
	});
	await db.insert(agentTables.externalAgentSessions).values({
		id: SESSION,
		organizationId: ORG,
		principalId: PRINCIPAL,
		externalSessionKey: "codex:fixture",
		harness: "codex",
		harnessVersion: "1",
		modelProvider: "fixture",
		modelId: "fixture",
		modelVersion: "1",
		identitySource: "explicit",
		status: "active",
		creditEligible: true,
		startedAt: NOW,
		lastSeenAt: NOW,
	});
	mocks.load.mockResolvedValue({
		id: "fixture-resource",
		approvedScopes: { connectionsScopes: [{ name: "mcp:work.read" }] },
	});
});
afterEach(async () => {
	await Promise.all(pending);
	sqlite.close();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});
function client(extraHeaders: Record<string, string> = {}) {
	const ctx = {
		db,
		env: {
			PLATFORM_SERVICE_TOKEN: "fixture-signing",
			ENVIRONMENT: "test",
			DESCOPE_PROJECT_ID: "Pfixture",
			DESCOPE_MANAGEMENT_KEY: "fixture-management",
		} as CloudflareEnv,
		headers: new Headers({
			"X-API-Key": rawKey,
			"X-Service-Binding": "true",
			"X-Tedix-Caller-Type": "mcp-edge-external-agent-session-exchange",
			...extraHeaders,
		}),
		url: new URL("https://api/rpc/externalAgentIdentity/issueMcpCredential"),
		waitUntil: (p: Promise<unknown>) => {
			pending.push(p);
		},
	} as BaseContext;
	vi.spyOn(db.query.apps, "findFirst").mockResolvedValue({
		organizationId: ORG,
		slug: "example",
		metadata: { mcpConfig: { descopeResourceId: "fixture-resource" } },
	} as never);
	return createRouterClient(externalAgentIdentityContractRouter, {
		context: ctx,
	});
}
describe("session token exchange", () => {
	const resolve = (sessionId: string, clientRecordId: string) =>
		resolveAuthorizedExternalAgentMcpSession(db, {
			organizationId: ORG,
			principalId: PRINCIPAL,
			sessionId,
			clientRecordId,
			now: new Date().toISOString(),
		});
	it("issues concurrent sessions without provider clients and revokes only the selected bearer", async () => {
		const secondSession = "00000000-0000-4000-8000-000000000004";
		sqlite
			.prepare(
				"INSERT INTO external_agent_sessions SELECT ?, organization_id, principal_id, 'codex:second', harness, harness_version, model_provider, model_id, model_version, identity_source, status, credit_eligible, started_at, last_seen_at, ended_at, metadata FROM external_agent_sessions WHERE id = ?",
			)
			.run(secondSession, SESSION);
		const [first, second] = await Promise.all([
			client().issueMcpCredential(INPUT),
			client().issueMcpCredential({ ...INPUT, sessionId: secondSession }),
		]);
		expect(first.clientRecordId).toMatch(/^session:/);
		expect(first.clientRecordId).not.toBe(second.clientRecordId);
		expect(first.accessToken).not.toBe(second.accessToken);
		expect(mocks.create).not.toHaveBeenCalled();
		expect(mocks.secret).not.toHaveBeenCalled();
		expect(mocks.search).not.toHaveBeenCalled();
		const claims = await verifyExchangedToken(first.accessToken, {
			secret: "fixture-signing",
			audience: INPUT.mcpServerUrl,
		});
		expect(claims).toMatchObject({
			sub: `external-agent-session:${SESSION}`,
			act: { sub: `external-agent:${PRINCIPAL}` },
			scopes: INPUT.scopes,
		});
		expect(first.expiresIn).toBe(120);
		expect(
			(await resolve(SESSION, first.clientRecordId))?.credential.scopes,
		).toEqual(INPUT.scopes);
		await client({
			"X-Tedix-Caller-Type": "mcp-edge-external-agent",
			"X-Tedix-External-Agent-Principal-Id": PRINCIPAL,
			"X-Tedix-External-Agent-Session-Id": SESSION,
			"X-Tedix-External-Agent-Client-Record-Id": first.clientRecordId,
			"X-Tedix-Org-Id": ORG,
		}).revokeMcpCredential({
			organizationId: ORG,
			principalId: PRINCIPAL,
			sessionId: SESSION,
			clientRecordId: first.clientRecordId,
		});
		expect(await resolve(SESSION, first.clientRecordId)).toBeNull();
		expect(await resolve(secondSession, second.clientRecordId)).not.toBeNull();
		expect(await resolve(SESSION, second.clientRecordId)).toBeNull();
		expect(mocks.remove).not.toHaveBeenCalled();
	});
	it("bounds renewal to enrollment and denies expired or disabled enrollment", async () => {
		await client().issueMcpCredential(INPUT);
		vi.setSystemTime(new Date("2030-01-01T00:01:00.000Z"));
		const renewed = await client().issueMcpCredential(INPUT);
		expect(renewed.expiresIn).toBe(60);
		expect(
			(await resolve(SESSION, renewed.clientRecordId))?.credential.expiresAt,
		).toBe(DEADLINE);
		sqlite.prepare("UPDATE api_keys SET status = 'revoked'").run();
		expect(await resolve(SESSION, renewed.clientRecordId)).toBeNull();
		sqlite.prepare("UPDATE api_keys SET status = 'active'").run();
		vi.setSystemTime(new Date(DEADLINE));
		expect(await resolve(SESSION, renewed.clientRecordId)).toBeNull();
		await expect(client().issueMcpCredential(INPUT)).rejects.toThrow();
	});
	it("does not register a fallback client on resource lookup failure or an empty scope request", async () => {
		await expect(
			client().issueMcpCredential({ ...INPUT, scopes: [] }),
		).rejects.toThrow();
		mocks.load.mockRejectedValueOnce(new Error("provider unavailable"));
		await expect(client().issueMcpCredential(INPUT)).rejects.toThrow();
		expect(mocks.create).not.toHaveBeenCalled();
		expect(
			sqlite
				.prepare("SELECT count(*) AS n FROM external_agent_mcp_credentials")
				.get(),
		).toEqual({ n: 0 });
	});
});
