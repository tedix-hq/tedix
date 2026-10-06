import { describe, expect, it } from "vite-plus/test";
import {
	cloudflareAccessPrincipalIdentity,
	descopeServiceIdentity,
	descopeIssuer,
	descopeTenantIdentity,
	descopeUserIdentity,
} from "./principal-identity";

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
