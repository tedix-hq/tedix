import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { tokenExchangeGrants } from "@tedix/db/schema/token-exchange";
import { auditEvents } from "@tedix/db/schema/audit-events";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { exchangeToken } from "@tedix/auth/token-exchange";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";
import type { BaseContext } from "../rpc/context";
import { hasRequiredScope } from "../rpc/orpc";

const ORG = "00000000-0000-4000-8000-0000000000c1";
const TEDI = "00000000-0000-4000-8000-0000000000d1";
const MEMBER = "member-example";

const mocks = vi.hoisted(() => ({
	tedi: vi.fn(),
	member: vi.fn(),
}));
vi.mock("@tedix/db/queries/tedis", () => ({
	getTediByIdForOrganization: mocks.tedi,
}));
vi.mock("@tedix/db/queries/organization-members", () => ({
	getMemberByUserId: mocks.member,
}));

const {
	brokerInternalExchange,
	tokenExchangeSecret,
	verifyForwardedExchangedToken,
} = await import("./token-exchange-broker");
const { tokenExchangeContractRouter } =
	await import("../rpc/routers/token-exchange");

const env = {
	ENVIRONMENT: "test",
	TOKEN_EXCHANGE_PILOT: "on",
	SECRETS_MASTER_KEY: "fixture-master-key",
} as unknown as CloudflareEnv;

function setup() {
	const sqlite = new DatabaseSync(":memory:");
	onTestFinished(() => sqlite.close());
	sqlite.exec(schemaDdl(tokenExchangeGrants));
	sqlite.exec(schemaDdl(auditEvents));
	const db = createDbClient(createD1Facade(sqlite)) as BaseContext["db"];
	mocks.tedi.mockReset().mockResolvedValue({ id: TEDI, retiredAt: null });
	mocks.member.mockReset().mockResolvedValue({ status: "active" });
	const edge = (overrides: Partial<BaseContext> = {}): BaseContext =>
		({
			authType: "service-binding",
			serviceBindingPrincipal: "mcp-edge",
			tediId: TEDI,
			organizationId: ORG,
			descopeUserId: MEMBER,
			tediScopes: ["mcp:tedis.read", "tedis:read", "mcp:work.write"],
			env,
			db,
			headers: new Headers(),
			url: new URL("https://api/rpc/tedis/get"),
			...overrides,
		}) as BaseContext;
	return { db, sqlite, edge };
}

const forTedisGet = { endpoint: "tedis/get", scopes: ["mcp:tedis.read"] };

describe("token exchange broker", () => {
	it("issues a one-call token that keeps the member as subject and nests the tedi and MCP edge", async () => {
		const { edge, sqlite } = setup();
		const issued = await brokerInternalExchange(edge(), forTedisGet);
		expect(issued.claims).toMatchObject({
			sub: `user:${MEMBER}`,
			organizationId: ORG,
			act: { sub: "service:mcp", act: { sub: `tedi:${TEDI}` } },
			scopes: ["mcp:tedis.read", "tedis:read"],
			audience: "tedix:api",
		});
		expect(issued.claims.expiresAt - issued.claims.issuedAt).toBe(60);
		const [row] = sqlite
			.prepare("SELECT * FROM token_exchange_grants")
			.all() as Array<Record<string, unknown>>;
		expect(row).toMatchObject({
			jti: issued.claims.jti,
			subject: `user:${MEMBER}`,
			endpoint: "tedis/get",
			actor_chain: JSON.stringify(["service:mcp", `tedi:${TEDI}`]),
		});
		const audit = sqlite
			.prepare("SELECT action, organization_id, metadata FROM audit_events")
			.all() as Array<{
			action: string;
			organization_id: string;
			metadata: string;
		}>;
		expect(audit).toHaveLength(1);
		expect(audit[0]).toMatchObject({
			action: "token_exchange.issued",
			organization_id: ORG,
		});
		expect(JSON.parse(audit[0]!.metadata).actorChain).toEqual([
			"service:mcp",
			`tedi:${TEDI}`,
		]);
	});

	it("accepts the machine translation of a granular scope the tedi holds, nothing more", async () => {
		const { edge } = setup();
		const issued = await brokerInternalExchange(
			edge({ tediScopes: ["mcp:tedis.read"] }),
			forTedisGet,
		);
		expect(issued.claims.scopes).toEqual(["mcp:tedis.read", "tedis:read"]);
		await expect(
			brokerInternalExchange(edge({ tediScopes: ["tedis:read"] }), forTedisGet),
		).rejects.toThrow(/Scopes exceed/);
	});

	it("uses the tedi as subject when no member is acting", async () => {
		const { edge } = setup();
		const issued = await brokerInternalExchange(
			edge({ descopeUserId: undefined }),
			forTedisGet,
		);
		expect(issued.claims).toMatchObject({
			sub: `tedi:${TEDI}`,
			act: { sub: "service:mcp" },
		});
	});

	it.each([
		["the binding is not the MCP edge", { serviceBindingPrincipal: undefined }],
		["the caller is a user", { authType: "user" }],
		["no tedi is forwarded", { tediId: undefined }],
		["the organization is system", { organizationId: "system" }],
		[
			"an external agent forwards it",
			{ externalAgentPrincipalId: "00000000-0000-4000-8000-0000000000e1" },
		],
	] as const)("refuses when %s", async (_label, overrides) => {
		const { edge } = setup();
		await expect(
			brokerInternalExchange(
				edge(overrides as unknown as Partial<BaseContext>),
				forTedisGet,
			),
		).rejects.toMatchObject({ name: "TokenExchangeRefused" });
	});

	it("reports the pilot as disabled, distinctly, when it is off", async () => {
		const { edge } = setup();
		await expect(
			brokerInternalExchange(
				edge({ env: { ...env, TOKEN_EXCHANGE_PILOT: undefined } as never }),
				forTedisGet,
			),
		).rejects.toMatchObject({ name: "TokenExchangeDisabled" });
	});

	it("refuses a retired tedi, an inactive member, a scope the tedi lacks and itself as target", async () => {
		const { edge } = setup();
		mocks.tedi.mockResolvedValueOnce({ id: TEDI, retiredAt: "2026-01-01" });
		await expect(brokerInternalExchange(edge(), forTedisGet)).rejects.toThrow(
			"Tedi is not active",
		);
		mocks.member.mockResolvedValueOnce({ status: "suspended" });
		await expect(brokerInternalExchange(edge(), forTedisGet)).rejects.toThrow(
			"Acting member is not active",
		);
		await expect(
			brokerInternalExchange(edge(), {
				endpoint: "tedis/update",
				scopes: ["mcp:tedis.write"],
			}),
		).rejects.toThrow(/Scopes exceed/);
		await expect(
			brokerInternalExchange(edge(), {
				endpoint: "tokenExchange/revoke",
				scopes: ["mcp:tedis.read"],
			}),
		).rejects.toThrow("cannot target itself");
	});
});

describe("forwarded exchanged token", () => {
	it("admits exactly one call to its procedure and narrows scopes", async () => {
		const { edge, sqlite } = setup();
		const { token } = await brokerInternalExchange(edge(), forTedisGet);
		await expect(
			verifyForwardedExchangedToken(edge(), token, "tedis/update"),
		).rejects.toThrow(/another procedure/);
		const claims = await verifyForwardedExchangedToken(
			edge(),
			token,
			"tedis/get",
		);
		expect(claims.actorChain).toEqual(["service:mcp", `tedi:${TEDI}`]);
		expect(
			sqlite
				.prepare("SELECT action FROM audit_events ORDER BY action")
				.all()
				.map((row) => (row as { action: string }).action),
		).toEqual(["token_exchange.issued", "token_exchange.used"]);
		await expect(
			verifyForwardedExchangedToken(edge(), token, "tedis/get"),
		).rejects.toThrow(/revoked, used/);
	});

	it("refuses another tedi, another organization, another acting member, a forged signature and a revoked token", async () => {
		const { edge } = setup();
		const { token, claims } = await brokerInternalExchange(edge(), forTedisGet);
		await expect(
			verifyForwardedExchangedToken(
				edge({ descopeUserId: "member-other" }),
				token,
				"tedis/get",
			),
		).rejects.toThrow(/another caller/);
		await expect(
			verifyForwardedExchangedToken(
				edge({ descopeUserId: undefined }),
				token,
				"tedis/get",
			),
		).rejects.toThrow(/another caller/);
		await expect(
			verifyForwardedExchangedToken(
				edge({ tediId: "00000000-0000-4000-8000-0000000000d2" }),
				token,
				"tedis/get",
			),
		).rejects.toThrow(/another caller/);
		await expect(
			verifyForwardedExchangedToken(
				edge({ organizationId: "00000000-0000-4000-8000-0000000000c2" }),
				token,
				"tedis/get",
			),
		).rejects.toThrow(/another caller/);
		const forged = await exchangeToken({
			subject: {
				sub: `tedi:${TEDI}`,
				organizationId: ORG,
				scopes: ["mcp:tedis.read"],
				expiresAt: Math.floor(Date.now() / 1000) + 60,
			},
			actor: "service:mcp",
			audience: "tedix:api",
			allowedAudiences: ["tedix:api"],
			requestedScopes: ["mcp:tedis.read"],
			consentedScopes: ["mcp:tedis.read"],
			actorEntitlement: ["mcp:tedis.read"],
			secret: "another-secret",
		});
		await expect(
			verifyForwardedExchangedToken(
				edge({ descopeUserId: undefined }),
				forged.token,
				"tedis/get",
			),
		).rejects.toThrow("Invalid exchanged token");
		// Signed with the right key but never recorded by the broker.
		const unrecorded = await exchangeToken({
			...{
				subject: {
					sub: `tedi:${TEDI}`,
					organizationId: ORG,
					scopes: ["mcp:tedis.read"],
					expiresAt: Math.floor(Date.now() / 1000) + 60,
				},
				actor: "service:mcp",
				audience: "tedix:api",
				allowedAudiences: ["tedix:api"],
				requestedScopes: ["mcp:tedis.read"],
				consentedScopes: ["mcp:tedis.read"],
				actorEntitlement: ["mcp:tedis.read"],
			},
			secret: await tokenExchangeSecret(env),
		});
		await expect(
			verifyForwardedExchangedToken(
				edge({ descopeUserId: undefined }),
				unrecorded.token,
				"tedis/get",
			),
		).rejects.toThrow(/revoked, used/);

		const admin = createRouterClient(tokenExchangeContractRouter, {
			context: {
				...edge(),
				authType: "user",
				serviceBindingPrincipal: undefined,
				tediId: undefined,
				userRole: "admin",
				user: {
					aud: "test",
					exp: 2,
					iat: 1,
					iss: "https://auth.tedix.test",
					permissions: ["settings:manage"],
					roles: [],
					sub: "admin-example",
				},
			} as BaseContext,
		});
		await expect(admin.revoke({ jti: claims.jti })).resolves.toEqual({
			revoked: [claims.jti],
		});
		await expect(
			verifyForwardedExchangedToken(edge(), token, "tedis/get"),
		).rejects.toThrow(/revoked, used/);
	});

	it("lets only admins and owners revoke", async () => {
		const { edge } = setup();
		const { claims } = await brokerInternalExchange(edge(), forTedisGet);
		const member = createRouterClient(tokenExchangeContractRouter, {
			context: {
				...edge(),
				authType: "user",
				serviceBindingPrincipal: undefined,
				tediId: undefined,
				userRole: "member",
				user: {
					aud: "test",
					exp: 2,
					iat: 1,
					iss: "https://auth.tedix.test",
					permissions: ["settings:manage"],
					roles: [],
					sub: "member-example",
				},
			} as BaseContext,
		});
		await expect(member.revoke({ jti: claims.jti })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});
});

describe("scope gate with an exchanged token", () => {
	it("ignores the MCP tool pre-authorization and admits only the token's scopes", () => {
		const base = {
			authType: "service-binding",
			serviceBindingAuthorization: { source: "mcp-tool", toolId: "tool" },
			tediScopes: ["tedis:read"],
		} as const;
		expect(hasRequiredScope(base, "tedis:write")).toBe(true);
		const narrowed = {
			...base,
			exchangedToken: {
				jti: "j",
				subject: "s",
				actorChain: ["service:mcp"],
				scopes: ["tedis:read"],
			},
		};
		expect(hasRequiredScope(narrowed, "tedis:write")).toBe(false);
		expect(hasRequiredScope(narrowed, "tedis:read")).toBe(true);
	});
});
