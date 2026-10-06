import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { createRequire } from "node:module";

const { exportJWK, generateKeyPair, SignJWT } = await import(
	createRequire(
		new URL("../templates/tedix/src/auth/descope.ts", import.meta.url),
	).resolve("jose")
);
import { authenticate } from "../templates/tedix/src/auth/descope";
import { assertDescopeSessionBoundary } from "../templates/tedix/src/auth/descope-jwt-boundary";

describe("CMS Descope JWT boundary", () => {
	const options = {
		projectId: "P-project",
	};

	it("accepts the byte-exact issuer and exact project audience", () => {
		expect(() =>
			assertDescopeSessionBoundary(
				{
					aud: ["another-audience", "P-project"],
					iss: "P-project",
				},
				options,
			),
		).not.toThrow();
	});

	it("allows absent audience for project sessions", () => {
		expect(() =>
			assertDescopeSessionBoundary({ iss: "P-project" }, options),
		).not.toThrow();
	});

	it("rejects absent, prefix, suffix, and normalized-looking issuers", () => {
		for (const iss of [
			undefined,
			"evil-P-project",
			"P-project-extra",
			"https://auth.tedix.dev/P-project",
			"https://auth.tedix.dev/P-project/",
			"https://auth.tedix.dev/evil-P-project",
		]) {
			expect(() => assertDescopeSessionBoundary({ iss }, options)).toThrow(
				/issuer mismatch/,
			);
		}
	});

	it("rejects substring and absent-project audiences", () => {
		for (const aud of ["evil-P-project", ["other"], "P-project-extra"]) {
			expect(() =>
				assertDescopeSessionBoundary({ aud, iss: "P-project" }, options),
			).toThrow(/audience mismatch/);
		}
	});
});

vi.mock("cloudflare:workers", () => ({ env: {} }));

describe("CMS signed Descope session authentication", () => {
	const config = {
		projectId: "P-signed-session",
		baseUrl: "https://auth.cms-test.invalid",
		tenantId: "org_signed_session",
		roleMapping: { editor: 40 },
	};
	let signingKey: CryptoKey;
	beforeAll(async () => {
		const { privateKey, publicKey } = await generateKeyPair("RS256");
		signingKey = privateKey;
		const publicJwk = await exportJWK(publicKey);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const url = input instanceof Request ? input.url : String(input);
				expect(url).toBe(
					`${config.baseUrl}/${config.projectId}/.well-known/jwks.json`,
				);
				return Response.json({
					keys: [
						{ ...publicJwk, kid: "cms-session-test", alg: "RS256", use: "sig" },
					],
				});
			}),
		);
	});
	afterAll(() => vi.unstubAllGlobals());

	async function sign(claims: Record<string, unknown> = {}) {
		return new SignJWT({
			iss: config.projectId,
			email: "editor@example.com",
			name: "CMS Editor",
			dct: config.tenantId,
			roles: ["editor"],
			...claims,
		})
			.setProtectedHeader({ alg: "RS256", kid: "cms-session-test" })
			.setSubject("signed-editor")
			.setIssuedAt()
			.setExpirationTime(typeof claims.exp === "number" ? claims.exp : "5m")
			.sign(signingKey);
	}
	function request(token: string) {
		return new Request("https://signed-session.cms.tedix.dev/_emdash/admin", {
			headers: { Cookie: `DS=${token}` },
		});
	}

	it("verifies the signed raw-project session and preserves its tenant role", async () => {
		const result = await authenticate(
			request(await sign({ aud: ["other", config.projectId] })),
			config,
		);
		expect(result).toMatchObject({
			email: "editor@example.com",
			name: "CMS Editor",
			subject: "signed-editor",
			role: 40,
		});
	});

	it.each(["P-wrong-project", `${config.baseUrl}/${config.projectId}`])(
		"rejects a valid signature with a nonexact issuer %s",
		async (iss) => {
			await expect(
				authenticate(request(await sign({ iss })), config),
			).rejects.toThrow(/issuer mismatch/);
		},
	);

	it("rejects tampering even when the issuer and tenant still match", async () => {
		const token = await sign();
		const [header, body, signature] = token.split(".");
		const claims = JSON.parse(Buffer.from(body!, "base64url").toString());
		claims.roles = ["admin"];
		const tampered = `${header}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${signature}`;
		await expect(authenticate(request(tampered), config)).rejects.toThrow(
			/JWT validation failed/,
		);
	});

	it("rejects expired signed sessions beyond the existing clock tolerance", async () => {
		await expect(
			authenticate(
				request(await sign({ exp: Math.floor(Date.now() / 1000) - 120 })),
				config,
			),
		).rejects.toThrow(/JWT validation failed/);
	});

	it("rejects a signed audience from another project", async () => {
		await expect(
			authenticate(request(await sign({ aud: "P-wrong-project" })), config),
		).rejects.toThrow(/audience mismatch/);
	});

	it("rejects a signed session for a different selected tenant", async () => {
		await expect(
			authenticate(request(await sign({ dct: "org_other" })), config),
		).rejects.toThrow(/required tenant/);
	});
});
