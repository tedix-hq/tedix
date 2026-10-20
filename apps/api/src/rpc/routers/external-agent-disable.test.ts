import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import {
	beforeEach,
	afterEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import { createDbClient } from "@tedix/db/client";
import { apiKeys } from "@tedix/db/schema/api-keys";
import * as agentTables from "@tedix/db/schema/external-agent-identity";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { tableDdl } from "@tedix/db/test/schema-ddl";
import {
	disableExternalAgentPrincipal,
	setExternalAgentPrincipalStatus,
} from "@tedix/db/queries/external-agent-identity/principals";
import {
	acquireExternalAgentMcpIssuanceLease,
	recordExternalAgentMcpCredentialUnderLease,
	resolveAuthorizedExternalAgentMcpSession,
	listReapableExternalAgentMcpCredentials,
	markExternalAgentMcpCredentialsReaped,
} from "@tedix/db/queries/external-agent-identity/mcp-credentials";
import type { BaseContext } from "../orpc";
const mocks = vi.hoisted(() => ({ remove: vi.fn() }));
vi.mock("@tedix/auth/aih-client", async (load) => ({
	...(await load<typeof import("@tedix/auth/aih-client")>()),
	deleteDescopeMcpServerClients: mocks.remove,
}));
import { externalAgentIdentityContractRouter } from "./external-agent-identity";
const ORG = "00000000-0000-4000-8000-000000000001";
const PRINCIPAL = "00000000-0000-4000-8000-000000000002";
const SESSION = "00000000-0000-4000-8000-000000000003";
const NOW = "2030-01-01T00:00:00.000Z";
let sqlite: DatabaseSync;
let db: ReturnType<typeof createDbClient>;
const params = { organizationId: ORG, principalId: PRINCIPAL };
const resolveParams = {
	...params,
	sessionId: SESSION,
	clientRecordId: "fixture-client",
	now: NOW,
};
beforeEach(async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(NOW));
	mocks.remove.mockReset().mockResolvedValue(undefined);
	sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		[apiKeys, ...Object.values(agentTables)].flatMap(tableDdl).join(";"),
	);
	db = createDbClient(createD1Facade(sqlite));
	await db.insert(apiKeys).values({
		id: "fixture-key",
		organizationId: ORG,
		name: "Fixture",
		keyHash: "fictional-hash",
		keyPreview: "fixture",
		status: "active",
		previousKeyHash: "old-fictional-hash",
		previousKeyExpiresAt: "2030-01-02T00:00:00.000Z",
	});
	await db.insert(agentTables.externalAgentPrincipals).values({
		id: PRINCIPAL,
		organizationId: ORG,
		key: "fixture",
		displayName: "Fixture",
		credentialBindingType: "api_key",
		credentialBindingId: "fixture-key",
		createdByType: "user",
		createdById: "fixture-owner",
		metadata: { platform: "codex-cloud", allowedScopes: ["mcp:work.read"] },
	});
	await db.insert(agentTables.externalAgentSessions).values({
		id: SESSION,
		...params,
		externalSessionKey: "codex:fixture",
		harness: "codex",
		harnessVersion: "1",
		modelProvider: "fixture",
		modelId: "fixture",
		modelVersion: "1",
		identitySource: "native",
		startedAt: NOW,
		lastSeenAt: NOW,
	});
	await db.insert(agentTables.externalAgentMcpCredentials).values({
		id: "fixture-credential",
		...params,
		sessionId: SESSION,
		clientRecordId: "fixture-client",
		mcpServerId: "fixture-server",
		mcpServerUrl: "https://example.mcp.tedix.dev/mcp",
		issuedAt: NOW,
		expiresAt: "2030-01-01T00:10:00.000Z",
	});
});
afterEach(() => {
	sqlite.close();
	vi.useRealTimers();
});
function client(role = "admin", organizationId = ORG) {
	const context = {
		authType: "user",
		user: { sub: "fixture-owner" },
		userRole: role,
		organizationId,
		db,
		env: {
			ENVIRONMENT: "test",
			DESCOPE_PROJECT_ID: "fixture",
			DESCOPE_MANAGEMENT_KEY: "fictional-management",
		},
		headers: new Headers(),
		rateLimiter: { limit: async () => ({ success: true }) },
		url: new URL("https://api.tedix.test/rpc"),
		waitUntil: () => {},
	} as unknown as BaseContext;
	return createRouterClient(externalAgentIdentityContractRouter, { context });
}
describe("external-agent switch off", () => {
	it.each(["revoked", "expired", "wrong-org", "missing"])(
		"checks bound key on each MCP call: %s",
		async (mode) => {
			expect(
				await resolveAuthorizedExternalAgentMcpSession(db, resolveParams),
			).not.toBeNull();
			if (mode === "revoked")
				sqlite.exec("UPDATE api_keys SET status='revoked'");
			if (mode === "expired")
				sqlite.prepare("UPDATE api_keys SET expires_at=?").run(NOW);
			if (mode === "wrong-org")
				sqlite.exec("UPDATE api_keys SET organization_id='other-org'");
			if (mode === "missing") sqlite.exec("DELETE FROM api_keys");
			expect(
				await resolveAuthorizedExternalAgentMcpSession(db, resolveParams),
			).toBeNull();
		},
	);
	it("leaves owner-host and workload credentials independent of API keys", async () => {
		sqlite.exec(
			"UPDATE external_agent_principals SET credential_binding_type='owner_user'; DELETE FROM api_keys",
		);
		expect(
			await resolveAuthorizedExternalAgentMcpSession(db, resolveParams),
		).not.toBeNull();
	});
	it("atomically disables and fences an in-flight issuance even after resume", async () => {
		const lease = {
			...params,
			id: "lease",
			sessionId: SESSION,
			mcpServerId: "fixture-server",
			ownerToken: "lease-owner",
			now: NOW,
			expiresAt: "2030-01-01T00:01:00.000Z",
		};
		expect(await acquireExternalAgentMcpIssuanceLease(db, lease)).toBe(true);
		await disableExternalAgentPrincipal(db, {
			...params,
			reason: "Fixture switch off",
			now: NOW,
		});
		expect(
			await resolveAuthorizedExternalAgentMcpSession(db, resolveParams),
		).toBeNull();
		expect(
			sqlite.prepare("SELECT status, previous_key_hash FROM api_keys").get(),
		).toMatchObject({ status: "revoked", previous_key_hash: null });
		await setExternalAgentPrincipalStatus(db, {
			...params,
			status: "active",
			updatedAt: NOW,
		});
		expect(
			await resolveAuthorizedExternalAgentMcpSession(db, resolveParams),
		).toBeNull();
		await expect(
			recordExternalAgentMcpCredentialUnderLease(db, {
				id: "racing-credential",
				...params,
				sessionId: SESSION,
				clientRecordId: "racing-client",
				mcpServerId: "fixture-server",
				mcpServerUrl: "https://example.mcp.tedix.dev/mcp",
				issuedAt: NOW,
				expiresAt: "2030-01-01T00:10:00.000Z",
				leaseOwnerToken: "lease-owner",
				leaseNow: NOW,
			}),
		).rejects.toThrow("no longer owns");
	});
	it("rolls back every local change if any batch statement fails", async () => {
		sqlite.exec(
			"CREATE TRIGGER fail_key_revoke BEFORE UPDATE ON api_keys BEGIN SELECT RAISE(ABORT, 'fixture failure'); END",
		);
		await expect(
			disableExternalAgentPrincipal(db, {
				...params,
				reason: "Fixture",
				now: NOW,
			}),
		).rejects.toThrow("fixture failure");
		expect(
			await resolveAuthorizedExternalAgentMcpSession(db, resolveParams),
		).not.toBeNull();
		expect(
			sqlite.prepare("SELECT status FROM external_agent_principals").get(),
		).toMatchObject({ status: "active" });
	});
	it("chunks cleanup beyond D1's parameter limit", async () => {
		for (let i = 0; i < 120; i++)
			sqlite
				.prepare(
					"INSERT INTO external_agent_mcp_credentials SELECT ?, organization_id, principal_id, session_id, ?, mcp_server_id, mcp_server_url, status, issued_at, expires_at, revoked_at, provider_cleanup_at FROM external_agent_mcp_credentials WHERE id='fixture-credential'",
				)
				.run(`credential-${i}`, `client-${i}`);
		expect(
			await client().disablePrincipal({ ...params, reason: "Batch fixture" }),
		).toMatchObject({ metadata: { providerCleanup: "done" } });
		expect(mocks.remove.mock.calls.map((call) => call[1].ids.length)).toEqual([
			100, 21,
		]);
		expect(
			sqlite
				.prepare(
					"SELECT count(*) AS total FROM external_agent_mcp_credentials WHERE provider_cleanup_at IS NOT NULL",
				)
				.get(),
		).toMatchObject({ total: 121 });
	});
	it("keeps local denial on provider failure and reaps the revoked history later", async () => {
		mocks.remove.mockRejectedValue(new Error("provider unavailable"));
		const disabled = await client().disablePrincipal({
			...params,
			reason: "Fixture failure",
		});
		expect(disabled).toMatchObject({
			status: "suspended",
			metadata: { providerCleanup: "failed" },
		});
		expect(
			await resolveAuthorizedExternalAgentMcpSession(db, resolveParams),
		).toBeNull();
		const pending = await listReapableExternalAgentMcpCredentials(db, {
			expiredBefore: NOW,
			limit: 500,
		});
		expect(pending).toEqual([
			{ clientRecordId: "fixture-client", mcpServerId: "fixture-server" },
		]);
		await markExternalAgentMcpCredentialsReaped(db, {
			clientRecordIds: pending.map((row) => row.clientRecordId),
			revokedAt: NOW,
		});
		expect(
			await listReapableExternalAgentMcpCredentials(db, {
				expiredBefore: NOW,
				limit: 500,
			}),
		).toEqual([]);
		expect(
			JSON.parse(
				String(
					sqlite
						.prepare("SELECT metadata FROM external_agent_principals")
						.get()!.metadata,
				),
			),
		).toMatchObject({ providerCleanup: "done", platform: "codex-cloud" });
		expect(
			sqlite
				.prepare(
					"SELECT status, provider_cleanup_at FROM external_agent_mcp_credentials",
				)
				.get(),
		).toMatchObject({ status: "revoked", provider_cleanup_at: NOW });
	});
	it("deletes remotely only after local denial and finishes idempotently", async () => {
		mocks.remove.mockImplementation(async () => {
			expect(
				await resolveAuthorizedExternalAgentMcpSession(db, resolveParams),
			).toBeNull();
		});
		expect(
			await client().disablePrincipal({ ...params, reason: "Fixture disable" }),
		).toMatchObject({
			status: "suspended",
			metadata: { providerCleanup: "done" },
		});
		expect(
			await client().disablePrincipal({ ...params, reason: "Retry" }),
		).toMatchObject({ metadata: { providerCleanup: "done" } });
		expect(mocks.remove).toHaveBeenCalledTimes(1);
	});
	it("rejects members and cross-organization callers before mutation", async () => {
		await expect(
			client("member").disablePrincipal({ ...params, reason: "Denied" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			client("admin", "00000000-0000-4000-8000-000000000099").disablePrincipal({
				...params,
				reason: "Denied",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(
			await resolveAuthorizedExternalAgentMcpSession(db, resolveParams),
		).not.toBeNull();
		expect(mocks.remove).not.toHaveBeenCalled();
	});
});
