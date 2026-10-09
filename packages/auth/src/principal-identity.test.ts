import { describe, expect, it } from "vite-plus/test";
import {
	cloudflareAccessPrincipalIdentity,
	descopeServiceIdentity,
	descopeAgenticAppUserIssuer,
	descopeIssuer,
	descopeProjectUserIdentity,
	descopeTenantIdentity,
	descopeUserIdentity,
} from "./principal-identity";

describe("Descope agentic-app user tokens", () => {
	const options = {
		projectId: "P2fictional",
		baseUrl: "https://auth.example.test",
	};
	const agenticIssuer =
		"https://api.descope.com/v1/apps/agentic/P2fictional/RSapp1";
	const userToken = {
		iss: agenticIssuer,
		sub: "U2fictionaluser",
		email: "ada@example.test",
		client_id: "cimd-client",
		azp: "cimd-client",
		exp: 4_000_000_000,
	};

	it("names a same-project user token by the project issuer", () => {
		expect(descopeProjectUserIdentity(userToken, options)).toEqual({
			provider: "descope",
			issuer: "https://auth.example.test/P2fictional",
			subject: "U2fictionaluser",
		});
	});

	it.each([
		[
			"another project",
			"https://api.descope.com/v1/apps/agentic/P2other/RSapp1",
		],
		[
			"a lookalike host",
			"https://api.descope.com.evil.test/v1/apps/agentic/P2fictional/RSapp1",
		],
		[
			"a custom origin",
			"https://auth.example.test/v1/apps/agentic/P2fictional/RSapp1",
		],
		["plain http", "http://api.descope.com/v1/apps/agentic/P2fictional/RSapp1"],
		[
			"an extra segment",
			"https://api.descope.com/v1/apps/agentic/P2fictional/RSapp1/x",
		],
		["a missing app", "https://api.descope.com/v1/apps/agentic/P2fictional"],
		[
			"a non-agentic path",
			"https://api.descope.com/v1/apps/other/P2fictional/RSapp1",
		],
		[
			"a project prefix",
			"https://api.descope.com/v1/apps/agentic/P2fictionalX/RSapp1",
		],
		[
			"a query",
			"https://api.descope.com/v1/apps/agentic/P2fictional/RSapp1?x=1",
		],
		[
			"credentials",
			[
				"https://u:p",
				"api.descope.com/v1/apps/agentic/P2fictional/RSapp1",
			].join("@"),
		],
		["the bare project id", "P2fictional"],
	])("keeps the raw issuer for %s", (_label, iss) => {
		const token = { ...userToken, iss };
		expect(descopeAgenticAppUserIssuer(token, options)).toBeNull();
		expect(descopeProjectUserIdentity(token, options).issuer).toBe(
			iss.replace(/\/+$/, ""),
		);
	});

	it("does not map when no project is configured", () => {
		expect(
			descopeAgenticAppUserIssuer(userToken, { projectId: " " }),
		).toBeNull();
	});

	it.each([
		[
			"an AIH client-credentials subject",
			{ sub: "TPAclient1", email: undefined },
		],
		["a machine token without email", { email: undefined }],
		["a tedi entity", { entityType: "tedi" }],
		["a tedi id claim", { tediId: "tedi-1" }],
		["a delegated actor", { act: { sub: "TPAagent" } }],
		[
			"a subject equal to the client",
			{ sub: "Ucimd", client_id: "Ucimd", azp: "Ucimd" },
		],
		["a non-user subject", { sub: "external-agent-1" }],
	])("never maps %s to a human user", (_label, claims) => {
		const token = { ...userToken, ...claims };
		expect(descopeAgenticAppUserIssuer(token, options)).toBeNull();
		expect(descopeProjectUserIdentity(token, options).issuer).toBe(
			agenticIssuer,
		);
	});

	it("rejects a token without a subject", () => {
		const token = { ...userToken, sub: undefined };
		expect(descopeAgenticAppUserIssuer(token, options)).toBeNull();
		expect(() => descopeProjectUserIdentity(token, options)).toThrow(
			/missing sub/,
		);
	});

	it("leaves project-issuer tokens unchanged", () => {
		const token = {
			...userToken,
			iss: "https://auth.example.test/P2fictional",
		};
		expect(descopeProjectUserIdentity(token, options).issuer).toBe(
			"https://auth.example.test/P2fictional",
		);
	});
});

describe("provider-neutral principal identity", () => {
	it("constructs the certified Descope issuer from installation config", () => {
		expect(descopeIssuer("P-project", "https://auth.example.test/")).toBe(
			"https://auth.example.test/P-project",
		);
	});
	it("normalizes Descope issuer boundaries without interpreting subjects", () => {
		expect(
			descopeUserIdentity({
				iss: "https://auth.example.test/P-project/",
				sub: "U-user",
			}),
		).toEqual({
			provider: "descope",
			issuer: "https://auth.example.test/P-project",
			subject: "U-user",
		});
		expect(
			descopeTenantIdentity(
				{ iss: "https://auth.example.test/P-project" },
				"T-tenant",
			),
		).toMatchObject({ subject: "T-tenant" });
		expect(
			descopeServiceIdentity({
				iss: "https://api.example.test/P-project",
				client_id: "client-1",
			}),
		).toMatchObject({ subject: "client-1" });
	});

	it("fails closed on absent subjects", () => {
		expect(() =>
			descopeUserIdentity({ iss: "https://issuer", sub: undefined }),
		).toThrow(/missing sub/);
		expect(() =>
			descopeServiceIdentity({
				iss: "https://issuer",
				client_id: undefined,
			}),
		).toThrow(/missing client_id/);
	});

	it("adapts only runtime-verified Cloudflare Access user identities", async () => {
		await expect(
			cloudflareAccessPrincipalIdentity(
				{
					aud: "access-app-aud",
					getIdentity: async () => ({
						account_id: "cf-account",
						user_uuid: "access-user",
					}),
				},
				{
					expectedAccountId: "cf-account",
					expectedAudience: "access-app-aud",
					issuer: "https://tedix.cloudflareaccess.com/",
				},
			),
		).resolves.toEqual({
			provider: "cloudflare-access",
			issuer: "https://tedix.cloudflareaccess.com",
			subject: "user:access-user",
		});
	});

	it("keeps Access service tokens distinct from workforce users", async () => {
		await expect(
			cloudflareAccessPrincipalIdentity(
				{
					aud: "access-app-aud",
					getIdentity: async () => ({
						account_id: "cf-account",
						service_token_id: "service-token",
					}),
				},
				{
					expectedAccountId: "cf-account",
					expectedAudience: "access-app-aud",
					issuer: "https://tedix.cloudflareaccess.com",
				},
			),
		).resolves.toMatchObject({ subject: "service-token:service-token" });
	});

	it("rejects missing contexts, boundary mismatches, and ambiguous subjects", async () => {
		const options = {
			expectedAccountId: "cf-account",
			expectedAudience: "access-app-aud",
			issuer: "https://tedix.cloudflareaccess.com",
		};
		await expect(
			cloudflareAccessPrincipalIdentity(undefined, options),
		).rejects.toThrow(/context is required/);
		await expect(
			cloudflareAccessPrincipalIdentity(
				{ aud: "wrong", getIdentity: async () => undefined },
				options,
			),
		).rejects.toThrow(/audience mismatch/);
		await expect(
			cloudflareAccessPrincipalIdentity(
				{
					aud: "access-app-aud",
					getIdentity: async () => ({
						account_id: "wrong",
						user_uuid: "user",
					}),
				},
				options,
			),
		).rejects.toThrow(/account mismatch/);
		await expect(
			cloudflareAccessPrincipalIdentity(
				{
					aud: "access-app-aud",
					getIdentity: async () => ({
						account_id: "cf-account",
						service_token_id: "service",
						user_uuid: "user",
					}),
				},
				options,
			),
		).rejects.toThrow(/exactly one stable subject/);
	});
});
