import * as jose from "jose";
import { describe, expect, it } from "vite-plus/test";
import {
	actorChain,
	exchangeToken,
	type ExchangeRequest,
	verifyExchangedToken,
} from "./token-exchange";

const now = 1_800_000_000;
const secret = "fictional-test-secret";
const audience = "https://api.tedix.example";

function request(overrides: Partial<ExchangeRequest> = {}): ExchangeRequest {
	return {
		subject: {
			sub: "user:U_example",
			organizationId: "org-example",
			scopes: ["mcp:apps.read", "mcp:work.read", "mcp:work.write"],
			expiresAt: now + 3600,
			jti: "subject-jti",
		},
		actor: "tedi:tedi-example",
		audience,
		allowedAudiences: [audience],
		requestedScopes: ["mcp:work.read"],
		consentedScopes: ["mcp:apps.read", "mcp:work.read"],
		actorEntitlement: ["mcp:work.read", "mcp:work.write"],
		secret,
		now,
		...overrides,
	};
}

describe("internal token exchange", () => {
	it("keeps the originating subject and nests each hop's actor", async () => {
		const first = await exchangeToken(request());
		expect(first.response).toMatchObject({
			issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
			token_type: "Bearer",
			expires_in: 300,
			scope: "mcp:work.read",
		});
		const hop1 = await verifyExchangedToken(first.token, {
			secret,
			audience,
			now,
		});
		expect(hop1).toMatchObject({
			sub: "user:U_example",
			organizationId: "org-example",
			act: { sub: "tedi:tedi-example" },
			scopes: ["mcp:work.read"],
			parentJti: "subject-jti",
		});

		// tedi -> MCP -> API: the MCP service exchanges the tedi's token.
		const second = await exchangeToken(
			request({
				subject: {
					sub: hop1.sub,
					organizationId: hop1.organizationId,
					scopes: hop1.scopes,
					expiresAt: hop1.expiresAt,
					act: hop1.act,
					jti: hop1.jti,
				},
				actor: "service:mcp",
				now: now + 10,
			}),
		);
		const hop2 = await verifyExchangedToken(second.token, {
			secret,
			audience,
			now: now + 10,
		});
		expect(hop2.sub).toBe("user:U_example");
		expect(hop2.act).toEqual({
			sub: "service:mcp",
			act: { sub: "tedi:tedi-example" },
		});
		expect(actorChain(hop2.act)).toEqual(["service:mcp", "tedi:tedi-example"]);
		expect(hop2.parentJti).toBe(hop1.jti);
		// Never outlives the token it was exchanged from.
		expect(hop2.expiresAt).toBeLessThanOrEqual(hop1.expiresAt);
	});

	it("only narrows scopes: each requested scope must pass every limit", async () => {
		for (const overrides of [
			{ requestedScopes: ["mcp:work.write"] }, // not consented
			{ requestedScopes: ["mcp:apps.read"] }, // outside actor entitlement
			{ requestedScopes: ["mcp:settings.admin"] }, // subject lacks it
			{ toolPolicyScopes: ["mcp:apps.read"] }, // tool policy excludes it
			{ requestedScopes: [] },
			{ requestedScopes: ["*"] },
			{ requestedScopes: ["mcp:*"] },
			{ requestedScopes: ["mcp:work.read", "mcp:work.read"] },
		])
			await expect(exchangeToken(request(overrides))).rejects.toMatchObject({
				code: "invalid_scope",
			});
	});

	it("refuses an unlisted audience, an expired subject and a looping or deep chain", async () => {
		await expect(
			exchangeToken(request({ audience: "https://upstream.example" })),
		).rejects.toMatchObject({ code: "invalid_target" });
		await expect(
			exchangeToken(
				request({
					subject: { ...request().subject, expiresAt: now },
				}),
			),
		).rejects.toMatchObject({ code: "invalid_request" });
		await expect(
			exchangeToken(request({ actor: "user:U_example" })),
		).rejects.toMatchObject({ code: "invalid_request" });
		await expect(
			exchangeToken(
				request({
					subject: {
						...request().subject,
						act: { sub: "service:mcp", act: { sub: "tedi:tedi-example" } },
					},
				}),
			),
		).rejects.toMatchObject({ code: "invalid_request" });
		const deep = {
			sub: "a",
			act: { sub: "b", act: { sub: "c", act: { sub: "d" } } },
		};
		await expect(
			exchangeToken(request({ subject: { ...request().subject, act: deep } })),
		).rejects.toMatchObject({ code: "invalid_request" });
		expect(() => actorChain({ sub: "a", extra: true })).toThrow();
		expect(() => actorChain({ act: { sub: "a" } })).toThrow();
	});

	it("caps the lifetime at five minutes and the subject's remaining time", async () => {
		const capped = await exchangeToken(request({ lifetimeSeconds: 3600 }));
		expect(capped.claims.expiresAt - now).toBe(300);
		const short = await exchangeToken(
			request({ subject: { ...request().subject, expiresAt: now + 42 } }),
		);
		expect(short.claims.expiresAt - now).toBe(42);
	});

	it("rejects a token for another audience, after expiry, or signed with another key", async () => {
		const { token } = await exchangeToken(request());
		await expect(
			verifyExchangedToken(token, {
				secret,
				audience: "https://other.example",
				now,
			}),
		).rejects.toThrow();
		await expect(
			verifyExchangedToken(token, { secret, audience, now: now + 301 }),
		).rejects.toThrow();
		await expect(
			verifyExchangedToken(token, { secret: "other-secret", audience, now }),
		).rejects.toThrow();
	});

	it("rejects a validly signed token whose actor chain or lifetime is wrong", async () => {
		const sign = (claims: Record<string, unknown>, exp = now + 60) =>
			new jose.SignJWT({
				organizationId: "org-example",
				scope: "mcp:work.read",
				...claims,
			})
				.setProtectedHeader({ alg: "HS256", typ: "tedix-exchanged+jwt" })
				.setIssuer("tedix:token-exchange")
				.setSubject("user:U_example")
				.setAudience(audience)
				.setJti("jti-example")
				.setIssuedAt(now)
				.setExpirationTime(exp)
				.sign(new TextEncoder().encode(`tedix:token-exchange:v1:${secret}`));
		for (const token of [
			await sign({}),
			await sign({ act: { sub: "user:U_example" } }),
			await sign({ act: { sub: "a", act: { sub: "a" } } }),
			await sign({ act: { sub: "tedi:tedi-example" } }, now + 3600),
		])
			await expect(
				verifyExchangedToken(token, { secret, audience, now }),
			).rejects.toThrow();
		await expect(
			verifyExchangedToken(await sign({ act: { sub: "tedi:tedi-example" } }), {
				secret,
				audience,
				now,
			}),
		).resolves.toMatchObject({ act: { sub: "tedi:tedi-example" } });
	});
});
