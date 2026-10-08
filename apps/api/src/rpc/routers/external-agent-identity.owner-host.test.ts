import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { externalAgentIdentityContractRouter } from "./external-agent-identity";
import {
	corroborationPrincipal,
	ownerHostClientRecordId,
	verifiedExternalAgent,
} from "./work-items-principal";

const members = vi.hoisted(
	() =>
		new Map<
			string,
			{ userId: string; status: string; descopeUserId: string; role: string }
		>(),
);

vi.mock("@tedix/db/queries/organization-members", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/organization-members")
	>()),
	getMemberByCanonicalUserId: vi.fn(
		async (_db: unknown, organizationId: string, userId: string) =>
			members.get(`${organizationId}:${userId}`),
	),
	getMemberByUserId: vi.fn(
		async (_db: unknown, organizationId: string, subject: string) =>
			[...members.entries()].find(
				([key, member]) =>
					key.startsWith(`${organizationId}:`) &&
					member.descopeUserId === subject,
			)?.[1],
	),
}));

const ORG = "00000000-0000-4000-8000-000000000001";
const OTHER_ORG = "00000000-0000-4000-8000-000000000002";
const OWNER = "usr-owner-example";
const OTHER = "usr-other-example";

const DDL = `
CREATE TABLE external_agent_principals (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, key TEXT NOT NULL,
 display_name TEXT NOT NULL, status TEXT NOT NULL,
 credential_binding_type TEXT NOT NULL, credential_binding_id TEXT NOT NULL,
 created_by_type TEXT NOT NULL, created_by_id TEXT NOT NULL, metadata TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uniq_external_agent_principal_key
 ON external_agent_principals (organization_id, key);
CREATE UNIQUE INDEX uniq_external_agent_credential_binding
 ON external_agent_principals
 (organization_id, credential_binding_type, credential_binding_id);
CREATE TABLE external_agent_sessions (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, principal_id TEXT NOT NULL,
 external_session_key TEXT NOT NULL, harness TEXT NOT NULL,
 harness_version TEXT NOT NULL, model_provider TEXT NOT NULL,
 model_id TEXT NOT NULL, model_version TEXT NOT NULL,
 identity_source TEXT NOT NULL, status TEXT NOT NULL,
 credit_eligible INTEGER NOT NULL, started_at TEXT NOT NULL,
 last_seen_at TEXT NOT NULL, ended_at TEXT, metadata TEXT NOT NULL
);
CREATE UNIQUE INDEX uniq_external_agent_session_key
 ON external_agent_sessions (organization_id, harness, external_session_key);
`;

let sqlite: DatabaseSync;

function userContext(
	userId: string,
	options: { organizationId?: string; ownerHostSessionId?: string } = {},
): BaseContext {
	return {
		authType: "user",
		user: {
			sub: `descope-${userId}`,
			name: "Example Owner",
			email: "owner@example.test",
		} as never,
		userId,
		userRole: "member",
		organizationId: options.organizationId ?? ORG,
		ownerHostSessionId: options.ownerHostSessionId,
		db: createDbClient(createD1Facade(sqlite)) as BaseContext["db"],
		env: { ENVIRONMENT: "test" } as CloudflareEnv,
		headers: new Headers(),
		rateLimiter: { limit: async () => ({ success: true }) } as RateLimit,
		url: new URL("https://api.tedix.test/rpc/externalAgentIdentity"),
		waitUntil: () => {},
	} as unknown as BaseContext;
}

function client(context: BaseContext) {
	return createRouterClient(externalAgentIdentityContractRouter, { context });
}

const TUPLE = {
	harness: "claude-desktop",
	harnessVersion: "1.0.0",
	modelProvider: "anthropic",
	modelId: "claude-example",
	modelVersion: "2026-10-01",
};

beforeEach(() => {
	sqlite = new DatabaseSync(":memory:");
	sqlite.exec(DDL);
	members.clear();
	for (const [organizationId, userId] of [
		[ORG, OWNER],
		[ORG, OTHER],
		[OTHER_ORG, OWNER],
	] as const) {
		members.set(`${organizationId}:${userId}`, {
			userId,
			status: "active",
			descopeUserId: `descope-${userId}`,
			role: "member",
		});
	}
});

describe("openOwnerHostSession", () => {
	it("creates the owner principal once and opens credit-ineligible sessions", async () => {
		const owner = client(userContext(OWNER));
		const first = await owner.openOwnerHostSession(TUPLE);
		expect(first.principal.key).toMatch(/^owner-host-[0-9a-f]{12}$/);
		expect(first.principal.displayName).toBe("Plugin hosts of Example Owner");
		expect(first.session).toMatchObject({
			principalId: first.principal.id,
			harness: "claude-desktop",
			identitySource: "explicit",
			creditEligible: false,
			status: "active",
			metadata: { ownerBound: true, source: "mcp-plugin" },
		});
		expect(first.session.externalSessionKey).toMatch(/^claude-desktop:/);
		expect(first).not.toHaveProperty("credential");

		const second = await owner.openOwnerHostSession(TUPLE);
		expect(second.principal.id).toBe(first.principal.id);
		expect(second.session.id).not.toBe(first.session.id);

		const principals = sqlite
			.prepare(
				"SELECT credential_binding_type, credential_binding_id, created_by_id FROM external_agent_principals",
			)
			.all();
		expect(principals).toEqual([
			{
				credential_binding_type: "owner_user",
				credential_binding_id: OWNER,
				created_by_id: OWNER,
			},
		]);
	});

	it("reuses an identical session key and rejects a changed tuple", async () => {
		const owner = client(userContext(OWNER));
		const key = "claude-desktop:thread-1";
		const opened = await owner.openOwnerHostSession({
			...TUPLE,
			externalSessionKey: key,
		});
		const replay = await owner.openOwnerHostSession({
			...TUPLE,
			externalSessionKey: key,
		});
		expect(replay.session.id).toBe(opened.session.id);
		await expect(
			owner.openOwnerHostSession({
				...TUPLE,
				externalSessionKey: key,
				modelVersion: "2026-11-01",
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		await expect(
			owner.openOwnerHostSession({
				...TUPLE,
				externalSessionKey: "codex:thread-1",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("never reuses another user's session key", async () => {
		const key = "claude-desktop:shared";
		await client(userContext(OWNER)).openOwnerHostSession({
			...TUPLE,
			externalSessionKey: key,
		});
		await expect(
			client(userContext(OTHER)).openOwnerHostSession({
				...TUPLE,
				externalSessionKey: key,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});

	it("rejects non-user callers and inactive members", async () => {
		const apiKey = userContext(OWNER);
		apiKey.authType = "apikey";
		apiKey.user = undefined;
		apiKey.apiKey = {
			id: "key-1",
			name: "agent",
			organizationId: ORG,
			scopes: ["*"],
		} as never;
		await expect(
			client(apiKey).openOwnerHostSession(TUPLE),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		const service = userContext(OWNER);
		service.authType = "service-binding";
		await expect(
			client(service).openOwnerHostSession(TUPLE),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		members.get(`${ORG}:${OWNER}`)!.status = "suspended";
		await expect(
			client(userContext(OWNER)).openOwnerHostSession(TUPLE),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("reserves the owner-host key prefix so a victim's key cannot be squatted", async () => {
		const admin = userContext(OTHER);
		admin.userRole = "owner";
		for (const key of ["owner-host-0123456789ab", "Owner-Host-squat"]) {
			await expect(
				client(admin).createPrincipal({
					key,
					displayName: "Squatter",
					credentialBindingType: "github_actions_oidc",
					credentialBindingId: "repo:example/squat:ref:refs/heads/main",
					metadata: { allowedScopes: ["mcp:work.read"] },
				}),
			).rejects.toMatchObject({
				code: "BAD_REQUEST",
				message: expect.stringMatching(/reserved for owner-host/),
			});
		}
		expect(
			sqlite
				.prepare("SELECT count(*) AS n FROM external_agent_principals")
				.get(),
		).toEqual({ n: 0 });
	});

	it("cannot create owner_user principals through createPrincipal", async () => {
		const admin = userContext(OWNER);
		admin.userRole = "owner";
		await expect(
			client(admin).createPrincipal({
				key: "forged-owner-host",
				displayName: "Forged",
				credentialBindingType: "owner_user" as never,
				credentialBindingId: OTHER,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});
});

describe("owner-host Work identity", () => {
	it("accepts an owner-host session only for its owning user", async () => {
		const opened = await client(userContext(OWNER)).openOwnerHostSession(TUPLE);
		const verified = await verifiedExternalAgent(
			userContext(OWNER, { ownerHostSessionId: opened.session.id }),
			ORG,
		);
		expect(verified).toEqual({
			executor: {
				type: "external_agent",
				id: opened.principal.id,
				sessionId: opened.session.id,
			},
			externalSessionKey: opened.session.externalSessionKey,
			harness: "claude-desktop",
			clientRecordId: ownerHostClientRecordId(opened.session.id),
			creditEligible: false,
			ownerBound: true,
		});

		await expect(
			verifiedExternalAgent(
				userContext(OTHER, { ownerHostSessionId: opened.session.id }),
				ORG,
			),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		await expect(
			verifiedExternalAgent(
				userContext(OWNER, {
					organizationId: OTHER_ORG,
					ownerHostSessionId: opened.session.id,
				}),
				OTHER_ORG,
			),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});

	it("rejects a non-user principal carrying an owner-host session", async () => {
		const opened = await client(userContext(OWNER)).openOwnerHostSession(TUPLE);
		const service = userContext(OWNER, {
			ownerHostSessionId: opened.session.id,
		});
		service.authType = "service-binding";
		await expect(verifiedExternalAgent(service, ORG)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});

	it("is unchanged without an owner-host session and never earns corroboration credit", async () => {
		expect(await verifiedExternalAgent(userContext(OWNER), ORG)).toBeNull();
		const opened = await client(userContext(OWNER)).openOwnerHostSession(TUPLE);
		await expect(
			corroborationPrincipal(
				userContext(OWNER, { ownerHostSessionId: opened.session.id }),
				ORG,
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("resolves the caller's own session for the edge preflight", async () => {
		const opened = await client(userContext(OWNER)).openOwnerHostSession(TUPLE);
		await expect(
			client(userContext(OWNER)).resolveOwnerHostSession({
				sessionId: opened.session.id,
			}),
		).resolves.toMatchObject({
			session: { id: opened.session.id },
			principal: { id: opened.principal.id },
		});
		await expect(
			client(userContext(OTHER)).resolveOwnerHostSession({
				sessionId: opened.session.id,
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});
});

describe("renamePrincipal", () => {
	it("lets an owner rename a principal's display name and keeps its key", async () => {
		const opened = await client(userContext(OWNER)).openOwnerHostSession(TUPLE);
		const member = client(userContext(OTHER));
		await expect(
			member.renamePrincipal({
				organizationId: ORG,
				principalId: opened.principal.id,
				displayName: "Taken over",
			}),
		).rejects.toThrow(/owner\/admin authority/);

		const owner = client({
			...userContext(OWNER),
			userRole: "owner",
		} as BaseContext);
		const renamed = await owner.renamePrincipal({
			organizationId: ORG,
			principalId: opened.principal.id,
			displayName: "Local coding agents (ada@laptop)",
		});
		expect(renamed).toMatchObject({
			id: opened.principal.id,
			key: opened.principal.key,
			displayName: "Local coding agents (ada@laptop)",
		});
	});
});
