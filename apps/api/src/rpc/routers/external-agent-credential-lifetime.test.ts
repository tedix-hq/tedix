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
let expiresIn: number | undefined;
let pending: Promise<unknown>[];
let providerTurn: (() => void) | undefined;
beforeEach(async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(NOW));
	vi.clearAllMocks();
	sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(
		[apiKeys, principalIdentities, ...Object.values(agentTables)]
			.flatMap(tableDdl)
			.join(";"),
	);
	db = createDbClient(createD1Facade(sqlite));
	pending = [];
	expiresIn = 600;
	providerTurn = undefined;
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
		approvedScopes: { connectionsScopes: [{ name: "mcp:work.read" }] },
	});
	mocks.create.mockResolvedValue({
		id: "fixture-client-record",
		clientId: "fixture-client",
		clientSecret: "fixture-secret",
	});
	mocks.remove.mockResolvedValue(undefined);
	mocks.secret.mockResolvedValue("fixture-secret");
	mocks.search.mockResolvedValue([
		{
			id: "fixture-client-record",
			clientId: "fixture-client",
			status: "verified",
			scopes: ["mcp:work.read"],
			tags: [
				"external-agent",
				`external-agent-org:${ORG}`,
				`external-agent-principal:${PRINCIPAL}`,
				`external-agent-session:${SESSION}`,
			],
		},
	]);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			providerTurn?.();
			return new Response(
				JSON.stringify({
					access_token: "fixture-bearer",
					expires_in: expiresIn,
				}),
				{ status: 200 },
			);
		}),
	);
});
afterEach(async () => {
	await Promise.all(pending);
	sqlite.close();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});
function client() {
	const ctx = {
		db,
		env: {
			ENVIRONMENT: "test",
			DESCOPE_PROJECT_ID: "Pfixture",
			DESCOPE_MANAGEMENT_KEY: "fixture-management",
		} as CloudflareEnv,
		headers: new Headers({
			"X-API-Key": rawKey,
			"X-Service-Binding": "true",
			"X-Tedix-Caller-Type": "mcp-edge-external-agent-session-exchange",
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
describe("enrollment-bounded MCP credential issuance", () => {
	it("caps both initial issuance and renewal to the two-minute enrollment deadline", async () => {
		const first = await client().issueMcpCredential(INPUT);
		expect(first.expiresIn).toBe(120);
		expect(
			sqlite
				.prepare("SELECT expires_at FROM external_agent_mcp_credentials")
				.get(),
		).toEqual({ expires_at: DEADLINE });
		vi.setSystemTime(new Date("2030-01-01T00:01:00.000Z"));
		const second = await client().issueMcpCredential(INPUT);
		expect(second.expiresIn).toBe(60);
		expect(mocks.create).toHaveBeenCalledTimes(1);
		expect(
			sqlite
				.prepare("SELECT expires_at FROM external_agent_mcp_credentials")
				.get(),
		).toEqual({ expires_at: DEADLINE });
	});
	it.each([undefined, 3600])(
		"fails issuance for provider expires_in %s and removes its unrecorded client",
		async (lifetime) => {
			expiresIn = lifetime;
			await expect(client().issueMcpCredential(INPUT)).rejects.toMatchObject({
				code: "INTERNAL_SERVER_ERROR",
				message: expect.stringContaining("expires_in"),
			});
			expect(
				sqlite
					.prepare(
						"SELECT count(*) AS total FROM external_agent_mcp_credentials",
					)
					.get(),
			).toEqual({ total: 0 });
			expect(mocks.remove).toHaveBeenCalledTimes(1);
		},
	);
	it("rejects renewal at the enrollment deadline without contacting the provider", async () => {
		vi.setSystemTime(new Date(DEADLINE));
		await expect(client().issueMcpCredential(INPUT)).rejects.toMatchObject({
			code: "UNAUTHORIZED",
			message: expect.stringContaining("enrollment_expired"),
		});
		expect(mocks.create).not.toHaveBeenCalled();
	});
	it("rechecks expiry when enrollment expires during the provider exchange", async () => {
		providerTurn = () => vi.setSystemTime(new Date(DEADLINE));
		await expect(client().issueMcpCredential(INPUT)).rejects.toMatchObject({
			code: "UNAUTHORIZED",
			message: expect.stringContaining("enrollment_expired"),
		});
		expect(
			sqlite
				.prepare("SELECT count(*) AS total FROM external_agent_mcp_credentials")
				.get(),
		).toEqual({ total: 0 });
		expect(mocks.remove).toHaveBeenCalledTimes(1);
	});
	it("limits the thirty-first authenticated exchange across sessions before provider work", async () => {
		for (let i = 0; i < 30; i++)
			expect((await client().issueMcpCredential(INPUT)).expiresIn).toBe(120);
		const anotherSession = crypto.randomUUID();
		await db.insert(agentTables.externalAgentSessions).values({
			id: anotherSession,
			organizationId: ORG,
			principalId: PRINCIPAL,
			externalSessionKey: "codex:other-session",
			harness: "codex",
			harnessVersion: "1",
			modelProvider: "fixture",
			modelId: "fixture",
			modelVersion: "1",
			identitySource: "explicit",
			startedAt: NOW,
			lastSeenAt: NOW,
		});
		const providerCalls = vi.mocked(fetch).mock.calls.length;
		await expect(
			client().issueMcpCredential({ ...INPUT, sessionId: anotherSession }),
		).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
		expect(vi.mocked(fetch).mock.calls).toHaveLength(providerCalls);
		await expect(client().issueMcpCredential(INPUT)).rejects.toMatchObject({
			code: "TOO_MANY_REQUESTS",
		});
		vi.setSystemTime(new Date("2030-01-01T00:01:00.000Z"));
		expect((await client().issueMcpCredential(INPUT)).expiresIn).toBe(60);
	});
});
