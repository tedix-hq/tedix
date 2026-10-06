import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vite-plus/test";
import {
	GITHUB_ACTIONS_OIDC_ISSUER,
	TEDIX_EXTERNAL_AGENT_WORKLOAD_AUDIENCE,
	issueExternalAgentWorkloadGrant,
	resolveFederatedWorkloadScopes,
	verifyExternalAgentWorkloadGrant,
	verifyGithubActionsWorkloadToken,
} from "./workload-identity";

const subject = "repo:tedix-hq/tedix:environment:production";

async function fixtureToken(
	overrides: Record<string, unknown> = {},
	header: { alg: string; kid: string } = { alg: "RS256", kid: "test" },
) {
	const { privateKey, publicKey } = await generateKeyPair("RS256");
	const jwk = await exportJWK(publicKey);
	const now = Math.floor(Date.now() / 1000);
	const token = await new SignJWT({ jti: "run-123", ...overrides })
		.setProtectedHeader(header)
		.setIssuer(GITHUB_ACTIONS_OIDC_ISSUER)
		.setAudience(TEDIX_EXTERNAL_AGENT_WORKLOAD_AUDIENCE)
		.setSubject(subject)
		.setIssuedAt(now)
		.setExpirationTime(now + 300)
		.sign(privateKey);
	return {
		jwk: { ...jwk, alg: "RS256", kid: "test" },
		token,
	};
}

describe("GitHub Actions workload identity", () => {
	it("verifies the exact issuer, audience, subject, algorithm, lifetime, and jti", async () => {
		const fixture = await fixtureToken();
		await expect(
			verifyGithubActionsWorkloadToken(fixture.token, {
				expectedSubject: subject,
				jwk: fixture.jwk,
			}),
		).resolves.toMatchObject({
			audience: TEDIX_EXTERNAL_AGENT_WORKLOAD_AUDIENCE,
			issuer: GITHUB_ACTIONS_OIDC_ISSUER,
			jti: "run-123",
			subject,
		});
	});

	it.each([
		[
			"subject",
			"repo:other/repo:environment:production",
			TEDIX_EXTERNAL_AGENT_WORKLOAD_AUDIENCE,
		],
		["audience", subject, "https://evil.example"],
	])(
		"rejects %s binding drift",
		async (_label, expectedSubject, expectedAudience) => {
			const fixture = await fixtureToken();
			await expect(
				verifyGithubActionsWorkloadToken(fixture.token, {
					expectedAudience,
					expectedSubject,
					jwk: fixture.jwk,
				}),
			).rejects.toMatchObject({
				name: "WorkloadIdentityError",
			});
		},
	);

	it("rejects a missing replay identifier", async () => {
		const fixture = await fixtureToken({ jti: undefined });
		await expect(
			verifyGithubActionsWorkloadToken(fixture.token, {
				expectedSubject: subject,
				jwk: fixture.jwk,
			}),
		).rejects.toMatchObject({ code: "missing_jti" });
	});

	it("rejects scope escalation instead of silently intersecting it", () => {
		expect(
			resolveFederatedWorkloadScopes(["apps:read"], ["apps:read"]),
		).toEqual(["apps:read"]);
		expect(() =>
			resolveFederatedWorkloadScopes(
				["apps:read", "platform:admin"],
				["apps:read"],
			),
		).toThrow(/unauthorized scopes/);
	});
});

describe("internal workload exchange grant", () => {
	const binding = {
		organizationId: "00000000-0000-4000-8000-000000000001",
		principalId: "00000000-0000-4000-8000-000000000002",
		sessionId: "00000000-0000-4000-8000-000000000003",
	};
	const secret = "test-only-workload-grant-secret-at-least-32-bytes";

	it("round-trips a short-lived, exactly bound grant", async () => {
		const now = Math.floor(Date.now() / 1_000);
		const token = await issueExternalAgentWorkloadGrant({
			...binding,
			secret,
			exchangeId: "exchange-1",
			scopes: ["apps:read"],
			expiresAt: now + 60,
			issuedAt: now,
		});
		await expect(
			verifyExternalAgentWorkloadGrant(token, { ...binding, secret }),
		).resolves.toMatchObject({
			exchangeId: "exchange-1",
			scopes: ["apps:read"],
		});
	});

	it("rejects tampering, binding drift, and expiry", async () => {
		const now = Math.floor(Date.now() / 1_000);
		const token = await issueExternalAgentWorkloadGrant({
			...binding,
			secret,
			exchangeId: "exchange-1",
			scopes: ["apps:read"],
			expiresAt: now + 60,
			issuedAt: now,
		});
		const [header, payload, signature] = token.split(".");
		const tampered = `${header}.${payload}.${signature!.startsWith("a") ? "b" : "a"}${signature!.slice(1)}`;
		await expect(
			verifyExternalAgentWorkloadGrant(tampered, {
				...binding,
				secret,
			}),
		).rejects.toMatchObject({ name: "WorkloadIdentityError" });
		await expect(
			verifyExternalAgentWorkloadGrant(token, {
				...binding,
				sessionId: "00000000-0000-4000-8000-000000000004",
				secret,
			}),
		).rejects.toMatchObject({ name: "WorkloadIdentityError" });
		const expired = await issueExternalAgentWorkloadGrant({
			...binding,
			secret,
			exchangeId: "exchange-2",
			scopes: ["apps:read"],
			expiresAt: now - 1,
			issuedAt: now - 61,
		});
		await expect(
			verifyExternalAgentWorkloadGrant(expired, { ...binding, secret }),
		).rejects.toMatchObject({ name: "WorkloadIdentityError" });
	});
});
