import { generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	exchangeGithubActionsWorkloadToken,
	federatedWorkloadCredentialId,
	GITHUB_ACTIONS_OIDC_ISSUER,
	workloadFederationConfig,
} from "./workload-identity";

const config = {
	clientId: "shared-workload-client",
	resource: "https://example.mcp.tedix.dev/mcp",
	repository: "example/project",
	ref: "refs/heads/main",
	workflowRef: "example/project/.github/workflows/ci.yml@refs/heads/main",
	expectedSubject: "repo:example/project:ref:refs/heads/main",
	scopes: ["mcp:work.read"],
};
const now = () => Math.floor(Date.now() / 1000);
async function assertion(overrides: Record<string, unknown> = {}) {
	const { privateKey } = await generateKeyPair("RS256");
	return new SignJWT({
		iss: GITHUB_ACTIONS_OIDC_ISSUER,
		aud: config.clientId,
		sub: config.expectedSubject,
		jti: "unique-run",
		iat: now(),
		exp: now() + 300,
		repository: config.repository,
		ref: config.ref,
		workflow_ref: config.workflowRef,
		...overrides,
	})
		.setProtectedHeader({ alg: "RS256", kid: "github-key" })
		.sign(privateKey);
}
async function response(overrides: Record<string, unknown> = {}) {
	const token = await new SignJWT({
		iss: "https://api.descope.com/v1/apps/agentic/Ptest/RSexample",
		aud: config.resource,
		sub: "workload-identity",
		azp: config.clientId,
		scope: config.scopes.join(" "),
		tedixWorkloadFederation: true,
		iat: now(),
		exp: now() + 300,
		...overrides,
	})
		.setProtectedHeader({ alg: "HS256" })
		.sign(new TextEncoder().encode("fixture-only-key"));
	return Response.json({
		access_token: token,
		expires_in: 300,
		token_type: "Bearer",
	});
}
afterEach(() => vi.unstubAllGlobals());

describe("Descope workload federation", () => {
	it("exchanges with one client and explicit scopes, without fetching GitHub JWKS", async () => {
		const fetch = vi.fn().mockResolvedValue(await response());
		vi.stubGlobal("fetch", fetch);
		const token = await assertion();
		const result = await exchangeGithubActionsWorkloadToken(token, config);
		expect(result.verified.subject).toBe(config.expectedSubject);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(fetch.mock.calls[0]![0]).toBe(
			"https://api.descope.com/oauth2/v1/apps/token",
		);
		const body = new URLSearchParams(fetch.mock.calls[0]![1].body);
		expect(Object.fromEntries(body)).toEqual({
			grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
			assertion: token,
			client_id: config.clientId,
			resource: config.resource,
			scope: "mcp:work.read",
		});
		expect(body.has("client_secret")).toBe(false);
		expect(
			await federatedWorkloadCredentialId(result.federation.accessToken),
		).toMatch(/^wif:[0-9a-f]{64}$/);
	});
	it.each([
		{ repository: "attacker/project" },
		{ ref: "refs/heads/untrusted" },
		{
			workflow_ref:
				"example/project/.github/workflows/untrusted.yml@refs/heads/main",
		},
		{ aud: "other-client" },
		{ iss: "https://untrusted.example" },
		{ sub: "repo:attacker/project:ref:refs/heads/main" },
		{ jti: undefined },
		{ exp: now() - 1 },
		{ iat: now() - 601 },
	])("rejects assertion claim drift %j before exchange", async (claims) => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		await expect(
			exchangeGithubActionsWorkloadToken(await assertion(claims), config),
		).rejects.toThrow();
		expect(fetch).not.toHaveBeenCalled();
	});
	it.each([
		{ aud: "https://wrong.example/mcp" },
		{ azp: "other-client" },
		{ scope: "mcp:work.read mcp:work.admin" },
		{ scope: "" },
		{ exp: now() + 3600 },
		{ tedixWorkloadFederation: undefined },
	])(
		"rejects an overbroad or misconfigured issued token %j",
		async (claims) => {
			vi.stubGlobal("fetch", vi.fn().mockResolvedValue(await response(claims)));
			await expect(
				exchangeGithubActionsWorkloadToken(await assertion(), config),
			).rejects.toThrow();
		},
	);
	it("fails closed on issuer rejection without retry or credential fallback", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValue(
				new Response("private-provider-body", { status: 401 }),
			);
		vi.stubGlobal("fetch", fetch);
		await expect(
			exchangeGithubActionsWorkloadToken(await assertion(), config),
		).rejects.toMatchObject({ code: "invalid_token" });
		expect(fetch).toHaveBeenCalledTimes(1);
	});
	it("keeps legacy only when federation configuration is absent", () => {
		expect(workloadFederationConfig({})).toBeNull();
		expect(
			workloadFederationConfig({ workloadFederation: config }),
		).toMatchObject(config);
		for (const value of [null, {}, { ...config, ref: "*" }])
			expect(() =>
				workloadFederationConfig({ workloadFederation: value }),
			).toThrow();
	});
});
