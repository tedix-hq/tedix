import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import {
	createDescopeMcpServerClient,
	deleteDescopeMcpServerClient,
	exchangeAihClientCredentials,
	loadDescopeMcpServer,
} from "@tedix/auth/aih-client";
import { validateToken } from "@tedix/auth/jwt";
import { verifyExternalAgentWorkloadGrant } from "@tedix/auth/workload-identity";
import { createDbClient } from "@tedix/db/client";
import { apiKeys } from "@tedix/db/schema/api-keys";
import * as agentTables from "@tedix/db/schema/external-agent-identity";
import { principalIdentities } from "@tedix/db/schema/principal-identities";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { tableDdl } from "@tedix/db/test/schema-ddl";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import {
	forgetMcpServerClients,
	forgetMcpServerRegistrations,
} from "../../lib/provider-facts-cache";
import type { BaseContext } from "../orpc";
import { externalAgentIdentityContractRouter } from "./external-agent-identity";

vi.mock("@tedix/auth/aih-client", async (load) => ({
	...(await load<typeof import("@tedix/auth/aih-client")>()),
	loadDescopeMcpServer: vi.fn(),
	createDescopeMcpServerClient: vi.fn(),
	deleteDescopeMcpServerClient: vi.fn(),
	exchangeAihClientCredentials: vi.fn(),
}));
vi.mock("@tedix/auth/jwt", async (load) => ({
	...(await load<typeof import("@tedix/auth/jwt")>()),
	validateToken: vi.fn(),
}));

const ORG = "00000000-0000-4000-8000-000000000001";
const KEY_PRINCIPAL = "00000000-0000-4000-8000-000000000010";
const RESOURCE = "https://tedix-unified.mcp.tedix.dev/mcp";
const BINDING = {
	id: "binding-record",
	clientId: "binding-client",
	clientSecret: "binding-secret",
};
const ENV = {
	ENVIRONMENT: "test",
	DESCOPE_PROJECT_ID: "Ptest",
	DESCOPE_MANAGEMENT_KEY: "fictional-management",
	SECRETS_MASTER_KEY: "fixture-only-secret",
} as unknown as CloudflareEnv;

let sqlite: DatabaseSync;
let db: ReturnType<typeof createDbClient>;

beforeEach(async () => {
	forgetMcpServerRegistrations();
	forgetMcpServerClients();
	vi.mocked(loadDescopeMcpServer).mockReset();
	vi.mocked(createDescopeMcpServerClient).mockReset();
	vi.mocked(deleteDescopeMcpServerClient).mockReset();
	vi.mocked(exchangeAihClientCredentials).mockReset();
	vi.mocked(validateToken).mockReset();
	sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		[apiKeys, principalIdentities, ...Object.values(agentTables)]
			.flatMap(tableDdl)
			.join(";"),
	);
	db = createDbClient(createD1Facade(sqlite));
	await db.insert(apiKeys).values({
		id: "legacy-key",
		organizationId: ORG,
		name: "Legacy",
		keyHash: "fictional-hash",
		keyPreview: "legacy",
		status: "active",
	});
	await db.insert(agentTables.externalAgentPrincipals).values({
		id: KEY_PRINCIPAL,
		organizationId: ORG,
		key: "legacy",
		displayName: "Legacy key principal",
		credentialBindingType: "api_key",
		credentialBindingId: "legacy-key",
		createdByType: "user",
		createdById: "fixture-owner",
		metadata: {},
	});
	vi.mocked(loadDescopeMcpServer).mockResolvedValue({
		approvedScopes: {
			connectionsScopes: [
				{ name: "mcp:work.read" },
				{ name: "mcp:work.write" },
			],
		},
	} as never);
	vi.mocked(createDescopeMcpServerClient).mockResolvedValue(BINDING);
	vi.mocked(deleteDescopeMcpServerClient).mockResolvedValue(undefined as never);
});
afterEach(() => {
	sqlite.close();
});

function context(
	auth:
		| { type: "user"; role?: string }
		| { type: "apikey"; id: string }
		| {
				type: "service-binding";
				path: "authorizeWorkloadSession" | "issueMcpCredential";
		  },
): BaseContext {
	const ctx = {
		authType: auth.type,
		user: auth.type === "user" ? { sub: "fixture-owner" } : undefined,
		userRole: auth.type === "user" ? (auth.role ?? "admin") : undefined,
		apiKey:
			auth.type === "apikey"
				? { id: auth.id, name: "Legacy", organizationId: ORG, scopes: [] }
				: undefined,
		organizationId: ORG,
		db,
		env: ENV,
		headers: new Headers(
			auth.type === "service-binding"
				? {
						"X-Service-Binding": "true",
						"X-Tedix-Caller-Type": "mcp-edge-external-agent-workload-exchange",
					}
				: {},
		),
		rateLimiter: { limit: async () => ({ success: true }) },
		url: new URL(
			auth.type === "service-binding"
				? `https://api/rpc/externalAgentIdentity/${auth.path}`
				: "https://api.tedix.test/rpc/external-agents",
		),
		waitUntil: () => {},
	} as unknown as BaseContext;
	vi.spyOn(ctx.db.query.apps, "findFirst").mockResolvedValue({
		metadata: { mcpConfig: { descopeResourceId: "resource" } },
	} as never);
	return ctx;
}

function client(ctx: BaseContext) {
	return createRouterClient(externalAgentIdentityContractRouter, {
		context: ctx,
	});
}

async function bootstrapM2m(scopes = ["mcp:work.read"]) {
	return client(context({ type: "user" })).createPrincipal({
		organizationId: ORG,
		key: "codex-m2m",
		displayName: "Codex M2M",
		credentialBindingType: "aih_m2m",
		mcpServerUrl: RESOURCE,
		scopes,
		metadata: { provisionedBy: "tedix-cli" },
	});
}

function m2mToken(overrides: Record<string, unknown> = {}) {
	const now = Math.floor(Date.now() / 1_000);
	vi.mocked(validateToken).mockResolvedValue({
		client_id: BINDING.clientId,
		iss: "Ptest",
		iat: now,
		exp: now + 600,
		jti: "jti-1",
		...overrides,
	} as never);
	return `${btoa(JSON.stringify({ alg: "RS256" }))}.${btoa(
		JSON.stringify({
			iss: `https://api.descope.com/v1/apps/agentic/Ptest/RS1`,
		}),
	)}.fixture`;
}

const tuple = {
	externalSessionKey: "codex:session-m2m",
	harness: "codex",
	harnessVersion: "1",
	modelProvider: "openai",
	modelId: "gpt-5.6",
	modelVersion: "2026-10-28",
};

describe("external-agent M2M binding", () => {
	it("binds a new principal to its own AIH client and returns the secret once", async () => {
		const created = await bootstrapM2m();
		expect(created.credentialBindingType).toBe("aih_m2m");
		expect(created.credentialBindingId).toBe(BINDING.id);
		expect(created.credential).toEqual({
			clientId: BINDING.clientId,
			clientSecret: BINDING.clientSecret,
			tokenUrl: "https://api.descope.com/oauth2/v1/apps/token",
			resource: RESOURCE,
		});
		expect(created.metadata).toMatchObject({
			provisionedBy: "tedix-cli",
			allowedScopes: ["mcp:work.read"],
			aihClientId: BINDING.clientId,
			aihMcpServerId: "resource",
		});
		expect(
			vi.mocked(createDescopeMcpServerClient).mock.calls[0]?.[1],
		).toMatchObject({
			mcpServerId: "resource",
			scopes: ["mcp:work.read"],
			tags: expect.arrayContaining(["external-agent-binding"]),
		});
		// The secret is handed back, never stored.
		expect(
			JSON.stringify(
				sqlite.prepare("SELECT metadata FROM external_agent_principals").all(),
			),
		).not.toContain(BINDING.clientSecret);
		expect(
			sqlite
				.prepare(
					"SELECT subject FROM principal_identities WHERE principal_id = ?",
				)
				.get(created.id),
		).toEqual({ subject: BINDING.clientId });
		expect(sqlite.prepare("SELECT count(*) AS n FROM api_keys").get()).toEqual({
			n: 1,
		});
	});

	it("refuses scopes the MCP server has not approved before minting a client", async () => {
		await expect(bootstrapM2m(["mcp:settings.admin"])).rejects.toThrow(
			/not approved|scope/i,
		);
		expect(createDescopeMcpServerClient).not.toHaveBeenCalled();
	});

	it("requires owner or admin authority", async () => {
		await expect(
			client(context({ type: "user", role: "member" })).createPrincipal({
				organizationId: ORG,
				key: "codex-m2m",
				displayName: "Codex M2M",
				credentialBindingType: "aih_m2m",
				mcpServerUrl: RESOURCE,
				scopes: ["mcp:work.read"],
			}),
		).rejects.toThrow(/owner\/admin authority/);
		expect(createDescopeMcpServerClient).not.toHaveBeenCalled();
	});

	it("opens a session for the principal's own token, within its ceiling, once", async () => {
		const created = await bootstrapM2m();
		const edge = client(
			context({ type: "service-binding", path: "authorizeWorkloadSession" }),
		);
		const authorized = await edge.authorizeWorkloadSession({
			organizationId: ORG,
			principalId: created.id,
			subjectToken: m2mToken(),
			...tuple,
			scopes: ["mcp:work.read"],
		});
		expect(authorized.session.principalId).toBe(created.id);
		expect(authorized.session.externalSessionKey).toBe(
			tuple.externalSessionKey,
		);
		const grant = await verifyExternalAgentWorkloadGrant(
			authorized.grantToken,
			{
				secret: ENV.SECRETS_MASTER_KEY,
				principalId: created.id,
				sessionId: authorized.session.id,
			},
		);
		expect(grant.scopes).toEqual(["mcp:work.read"]);
		expect(grant.federation).toBeUndefined();

		// The same assertion cannot open a second session.
		await expect(
			edge.authorizeWorkloadSession({
				organizationId: ORG,
				principalId: created.id,
				subjectToken: m2mToken(),
				...tuple,
				externalSessionKey: "codex:session-replay",
				scopes: ["mcp:work.read"],
			}),
		).rejects.toThrow(/already consumed/);

		// Wider than the ceiling granted at bootstrap is refused.
		await expect(
			edge.authorizeWorkloadSession({
				organizationId: ORG,
				principalId: created.id,
				subjectToken: m2mToken({ jti: "jti-2" }),
				...tuple,
				externalSessionKey: "codex:session-wide",
				scopes: ["mcp:work.read", "mcp:work.write"],
			}),
		).rejects.toThrow();
		expect(
			sqlite.prepare("SELECT count(*) AS n FROM external_agent_sessions").get(),
		).toEqual({ n: 1 });
	});

	it("refuses a token from another client, a human token, or an unbound principal", async () => {
		const created = await bootstrapM2m();
		const edge = client(
			context({ type: "service-binding", path: "authorizeWorkloadSession" }),
		);
		const request = (subjectToken: string, principalId = created.id) =>
			edge.authorizeWorkloadSession({
				organizationId: ORG,
				principalId,
				subjectToken,
				...tuple,
				scopes: ["mcp:work.read"],
			});
		await expect(
			request(m2mToken({ client_id: "someone-elses-client" })),
		).rejects.toThrow(/does not match the bound principal/);
		await expect(
			request(m2mToken({ email: "person@example.test", sub: "user-1" })),
		).rejects.toThrow(/not a client-credentials token/);
		vi.mocked(validateToken).mockRejectedValueOnce(new Error("bad signature"));
		await expect(request("not-a-token")).rejects.toThrow(/invalid/);
		// An API-key principal never accepts a bearer assertion.
		await expect(request(m2mToken(), KEY_PRINCIPAL)).rejects.toThrow(
			/not an active workload identity/,
		);
		expect(
			sqlite.prepare("SELECT count(*) AS n FROM external_agent_sessions").get(),
		).toEqual({ n: 0 });
	});

	it("issues the session credential under the grant with a per-session client", async () => {
		const created = await bootstrapM2m();
		const edge = client(
			context({ type: "service-binding", path: "authorizeWorkloadSession" }),
		);
		const authorized = await edge.authorizeWorkloadSession({
			organizationId: ORG,
			principalId: created.id,
			subjectToken: m2mToken(),
			...tuple,
			scopes: ["mcp:work.read"],
		});
		vi.mocked(createDescopeMcpServerClient).mockResolvedValueOnce({
			id: "session-record",
			clientId: "session-client",
			clientSecret: "session-secret",
		});
		vi.mocked(exchangeAihClientCredentials).mockResolvedValueOnce({
			accessToken: "session-bearer",
			expiresIn: 300,
		});
		const ctx = context({
			type: "service-binding",
			path: "issueMcpCredential",
		});
		ctx.headers.set(
			"X-Tedix-External-Agent-Workload-Grant",
			authorized.grantToken,
		);
		const issued = await client(ctx).issueMcpCredential({
			organizationId: ORG,
			principalId: created.id,
			sessionId: authorized.session.id,
			scopes: ["mcp:work.read"],
			mcpServerUrl: RESOURCE,
		});
		expect(issued.accessToken).toBe("session-bearer");
		expect(issued.clientRecordId).toBe("session-record");
		expect(issued.expiresIn).toBeLessThanOrEqual(300);
		// The binding client is never what the gateway sees.
		expect(exchangeAihClientCredentials).toHaveBeenCalledWith(
			expect.anything(),
			RESOURCE,
			"session-client",
			"session-secret",
		);
		expect(
			sqlite
				.prepare(
					"SELECT client_record_id FROM external_agent_mcp_credentials WHERE session_id = ?",
				)
				.all(authorized.session.id),
		).toEqual([{ client_record_id: "session-record" }]);
	});

	it("deletes the binding client when the principal is disabled", async () => {
		const created = await bootstrapM2m();
		await client(context({ type: "user" })).disablePrincipal({
			organizationId: ORG,
			principalId: created.id,
			reason: "machine retired",
		});
		expect(deleteDescopeMcpServerClient).toHaveBeenCalledWith(
			expect.anything(),
			{ id: BINDING.id, mcpServerId: "resource" },
		);
		expect(
			sqlite
				.prepare("SELECT status FROM principal_identities WHERE subject = ?")
				.get(BINDING.clientId),
		).toEqual({ status: "revoked" });
		expect(
			sqlite
				.prepare("SELECT status FROM external_agent_principals WHERE id = ?")
				.get(created.id),
		).not.toEqual({ status: "active" });
	});

	it("keeps an API-key principal's session exchange working", async () => {
		const session = await client(
			context({ type: "apikey", id: "legacy-key" }),
		).openSession({
			organizationId: ORG,
			principalId: KEY_PRINCIPAL,
			...tuple,
			externalSessionKey: "codex:legacy",
		});
		expect(session.principalId).toBe(KEY_PRINCIPAL);
	});
});
