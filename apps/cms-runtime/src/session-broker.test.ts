import { describe, expect, it } from "vite-plus/test";
import type { SessionBrokerRpc } from "@tedix/auth/session-broker";
import {
	cmsAuthRejectionCodes,
	CMS_BROKER_SESSION_COOKIE,
	CMS_FORWARDED_USER_AUTH_HEADER,
	diagnoseCmsProductSession,
	diagnoseCmsTenantRejection,
	handleCmsSessionBroker,
	withCmsProductSession,
} from "./session-broker";

function unsignedSession(claims: Record<string, unknown>): string {
	return `header.${btoa(JSON.stringify(claims)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")}.signature`;
}

const broker: SessionBrokerRpc = {
	async createIntent(input) {
		expect(input.tenantId).toBe("org_tedix");
		return {
			authorizeUrl:
				"https://auth.tedix.dev/tedix/session/authorize?intent=intent_123456789012345678901234",
			expiresAt: Math.floor(Date.now() / 1000) + 60,
			intentId: "intent_123456789012345678901234",
		};
	},
	async exchangeCode() {
		return { kind: "logout" };
	},
};

const env = {
	CMS_SESSION_BROKER: broker,
	ENVIRONMENT: "production",
};

describe("CMS product session broker", () => {
	it("sends any admin navigation without a product session to the broker", async () => {
		const response = await handleCmsSessionBroker(
			new Request("https://tedix.cms.tedix.dev/_emdash/admin/posts", {
				headers: { Accept: "text/html", Cookie: "DS=legacy" },
			}),
			env,
			"org_tedix",
			"tedix",
		);
		expect(response?.status).toBe(302);
		expect(response?.headers.get("location")).toContain(
			"/_emdash/api/auth/session-broker/start?redirect_to=",
		);
	});

	it("binds explicit tenant selection to the CMS broker entrypoint", async () => {
		const response = await handleCmsSessionBroker(
			new Request(
				"https://tedix.cms.tedix.dev/_emdash/api/auth/session-broker/start?redirect_to=%2F_emdash%2Fadmin",
				{ headers: { "Sec-Fetch-Site": "none" } },
			),
			env,
			"org_tedix",
			"tedix",
		);
		expect(response?.status).toBe(302);
		expect(response?.headers.get("location")).toContain(
			"https://auth.tedix.dev/tedix/session/authorize?intent=",
		);
	});

	it("routes the CMS login document through the broker", async () => {
		const response = await handleCmsSessionBroker(
			new Request("https://tedix.cms.tedix.dev/_emdash/admin/login", {
				headers: { Accept: "text/html" },
			}),
			env,
			"org_tedix",
			"tedix",
		);
		expect(response?.status).toBe(302);
		expect(response?.headers.get("location")).toBe(
			"https://tedix.cms.tedix.dev/_emdash/api/auth/session-broker/start?redirect_to=%2F_emdash%2Fadmin",
		);
	});

	it("never dispatches the CMS login document into an authenticated tenant bundle", async () => {
		const response = await handleCmsSessionBroker(
			new Request("https://tedix.cms.tedix.dev/_emdash/admin/login", {
				headers: {
					Accept: "text/html",
					Cookie: `${CMS_BROKER_SESSION_COOKIE}=broker-session`,
				},
			}),
			env,
			"org_tedix",
			"tedix",
		);
		expect(response?.status).toBe(302);
		expect(response?.headers.get("location")).toBe(
			"https://tedix.cms.tedix.dev/_emdash/admin",
		);
	});

	it("canonicalizes custom-domain admin navigation before broker login", async () => {
		const response = await handleCmsSessionBroker(
			new Request("https://blog.example.com/_emdash/admin/posts?view=draft", {
				headers: { Accept: "text/html" },
			}),
			env,
			"org_tedix",
			"tedix",
		);
		expect(response?.status).toBe(302);
		expect(response?.headers.get("location")).toBe(
			"https://tedix.cms.tedix.dev/_emdash/admin/posts?view=draft",
		);
		expect(response?.headers.get("cache-control")).toBe("no-store");
	});

	it("keeps development broker redirects on the development CMS domain", async () => {
		const response = await handleCmsSessionBroker(
			new Request("https://blog.example.com/_emdash/admin/posts", {
				headers: { Accept: "text/html" },
			}),
			{ ...env, ENVIRONMENT: "development" },
			"org_tedix",
			"tedix",
		);
		expect(response?.headers.get("location")).toBe(
			"https://tedix.cms.tedix.tech/_emdash/admin/posts",
		);
	});

	it("canonicalizes only the host-only product session for external auth", () => {
		const request = withCmsProductSession(
			new Request("https://tedix.cms.tedix.dev/_emdash/api/posts", {
				headers: {
					Cookie: `keep=value; DS=legacy; ${CMS_BROKER_SESSION_COOKIE}=broker`,
				},
			}),
		);
		expect(request.headers.get("Authorization")).toBeNull();
		expect(request.headers.get("Cookie")).toBe("keep=value; DS=broker");
	});

	it("reports only privacy-safe claim-shape diagnostics", () => {
		const session = unsignedSession({
			aud: "P-test",
			dct: "org_tedix",
			email: "private@example.com",
			exp: Math.floor(Date.now() / 1000) + 60,
			iss: "https://auth.tedix.dev/v1/apps/P-test",
			sub: "user-private",
		});
		expect(
			diagnoseCmsProductSession(
				new Request("https://tedix.cms.tedix.dev/_emdash/admin", {
					headers: { Cookie: `${CMS_BROKER_SESSION_COOKIE}=${session}` },
				}),
				env,
				{ projectId: "P-test", tenantId: "org_tedix" },
			),
		).toEqual({
			audienceMatchesProject: true,
			dctMatchesTenant: true,
			expiresInFuture: true,
			hasEmail: true,
			hasSubject: true,
			issuerMatchesProject: true,
			issuerIsProjectId: false,
		});
	});

	it.each([
		["P-test", "P-test", true],
		["P-test-other", "P-test", false],
		[undefined, "P-test", false],
		["P-test", undefined, false],
	] as const)(
		"reports only exact project-only issuer equality",
		(issuer, projectId, matches) => {
			const diagnostic = diagnoseCmsProductSession(
				new Request("https://tedix.cms.tedix.dev/_emdash/admin", {
					headers: {
						Cookie: `${CMS_BROKER_SESSION_COOKIE}=${unsignedSession({ iss: issuer, email: "private@example.com", sub: "private-subject" })}`,
					},
				}),
				env,
				{ projectId, tenantId: "org_tedix" },
			);
			expect(diagnostic?.issuerIsProjectId).toBe(matches);
			expect(JSON.stringify(diagnostic)).not.toMatch(/P-test|private/);
		},
	);

	it("preserves an explicit API or MCP Bearer over the browser session", () => {
		const request = withCmsProductSession(
			new Request("https://tedix.cms.tedix.dev/_emdash/api/mcp", {
				headers: {
					Authorization: "Bearer explicit",
					Cookie: `DS=legacy; ${CMS_BROKER_SESSION_COOKIE}=browser`,
				},
			}),
		);
		expect(request.headers.get("Authorization")).toBe("Bearer explicit");
		expect(request.headers.get("Cookie")).toBeNull();
	});

	it("strips a generic Descope session when no product cookie exists", () => {
		const request = withCmsProductSession(
			new Request("https://tedix.cms.tedix.dev/_emdash/api/posts", {
				headers: { Cookie: "keep=value; DS=legacy" },
			}),
			"shared_secret",
		);
		expect(request.headers.get("Authorization")).toBeNull();
		expect(request.headers.get("Cookie")).toBe("keep=value");
	});

	it("keeps an attested Studio user session without passing admin authority", () => {
		const request = withCmsProductSession(
			new Request("https://acme.cms.tedix.dev/_emdash/api/content", {
				headers: {
					Cookie: "keep=value; DS=aaa.bbb.ccc",
					[CMS_FORWARDED_USER_AUTH_HEADER]: "shared_secret",
				},
			}),
			"shared_secret",
		);
		expect(request.headers.get("Cookie")).toBe("keep=value; DS=aaa.bbb.ccc");
		expect(request.headers.get("X-Tedix-CMS-Internal-Auth")).toBeNull();
		expect(request.headers.get(CMS_FORWARDED_USER_AUTH_HEADER)).toBe("");
	});

	it("strips an unattested or ambiguous Studio user session", () => {
		for (const [attestation, cookie] of [
			["wrong_secret", "DS=aaa.bbb.ccc"],
			["shared_secret", "DS=aaa.bbb.ccc; DS=ddd.eee.fff"],
		] as const) {
			const request = withCmsProductSession(
				new Request("https://acme.cms.tedix.dev/_emdash/api/content", {
					headers: {
						Cookie: cookie,
						[CMS_FORWARDED_USER_AUTH_HEADER]: attestation,
					},
				}),
				"shared_secret",
			);
			expect(request.headers.get("Cookie")).toBeNull();
			expect(request.headers.get(CMS_FORWARDED_USER_AUTH_HEADER)).toBe("");
		}
	});

	it("keeps explicit PAT authority over an attested Studio user session", () => {
		const request = withCmsProductSession(
			new Request("https://acme.cms.tedix.dev/_emdash/api/content", {
				headers: {
					Authorization: "Bearer ec_pat_explicit",
					Cookie: "DS=aaa.bbb.ccc",
					[CMS_FORWARDED_USER_AUTH_HEADER]: "shared_secret",
				},
			}),
			"shared_secret",
		);
		expect(request.headers.get("Authorization")).toBe("Bearer ec_pat_explicit");
		expect(request.headers.get("Cookie")).toBeNull();
	});

	it("fails closed on duplicate product sessions instead of using legacy DS", () => {
		const request = withCmsProductSession(
			new Request("https://tedix.cms.tedix.dev/_emdash/api/posts", {
				headers: {
					Cookie: `DS=legacy; ${CMS_BROKER_SESSION_COOKIE}=one; ${CMS_BROKER_SESSION_COOKIE}=two`,
				},
			}),
		);
		expect(request.headers.get("Authorization")).toBeNull();
		expect(request.headers.get("Cookie")).toBeNull();
	});

	it("fails closed on an empty product session instead of using legacy DS", () => {
		const request = withCmsProductSession(
			new Request("https://tedix.cms.tedix.dev/_emdash/api/posts", {
				headers: {
					Cookie: `DS=legacy; ${CMS_BROKER_SESSION_COOKIE}=`,
				},
			}),
		);
		expect(request.headers.get("Authorization")).toBeNull();
		expect(request.headers.get("Cookie")).toBeNull();
	});

	it("never accepts a generic Descope session as product authority", () => {
		const request = withCmsProductSession(
			new Request("https://tedix.cms.tedix.dev/_emdash/api/posts", {
				headers: { Cookie: "keep=value; DS=legacy" },
			}),
		);
		expect(request.headers.get("Authorization")).toBeNull();
		expect(request.headers.get("Cookie")).toBe("keep=value");
	});
});

describe("CMS tenant rejection diagnostic", () => {
	it.each([
		new Headers({ Cookie: "keep=value; DS=private-session" }),
		new Headers({ Authorization: "Bearer private-token" }),
	])(
		"reports projected authentication without returning its value",
		(headers) => {
			const diagnostic = diagnoseCmsTenantRejection(
				new Request(
					"https://tenant.cms.tedix.dev/_emdash/admin?email=private@example.com",
					{ headers },
				),
				new Response(null, {
					status: 302,
					headers: {
						Location:
							"https://private@example.com:secret@auth.example.com/_emdash/api/auth/session-broker/start?token=private-token#private-fragment",
					},
				}),
			);
			expect(diagnostic).toEqual({
				hasProjectedSession: true,
				redirectPath: "/_emdash/api/auth/session-broker/start",
			});
			expect(JSON.stringify(diagnostic)).not.toMatch(
				/private|secret|example\.com|token=/,
			);
		},
	);

	it("reports a dropped session and a relative broker redirect", () => {
		expect(
			diagnoseCmsTenantRejection(
				new Request("https://tenant.cms.tedix.dev/_emdash/admin", {
					headers: {
						Cookie: `${CMS_BROKER_SESSION_COOKIE}=private; DS=; other=private`,
						Authorization: "Bearer ",
					},
				}),
				new Response(null, {
					status: 302,
					headers: {
						Location:
							"/_emdash/api/auth/session-broker/start?redirect_to=private",
					},
				}),
			),
		).toEqual({
			hasProjectedSession: false,
			redirectPath: "/_emdash/api/auth/session-broker/start",
		});
	});

	it.each([null, "http://[", "javascript:private-secret"])(
		"omits missing, malformed or non-HTTP redirect paths (%s)",
		(location) => {
			expect(
				diagnoseCmsTenantRejection(
					new Request("https://tenant.cms.tedix.dev/_emdash/admin"),
					new Response(null, {
						status: 401,
						headers: location === null ? {} : { Location: location },
					}),
				),
			).toEqual({ hasProjectedSession: false, redirectPath: null });
		},
	);
});

describe("CMS native auth rejection log projection", () => {
	it("projects recognized native codes from Worker Loader console arguments only", () => {
		expect(
			cmsAuthRejectionCodes([
				{
					message: [
						JSON.stringify({
							event: "cms.descope_auth_rejected",
							code: "jwt_validation:ERR_JWT_EXPIRED",
							message: "private@example.com secret",
						}),
					],
				},
				{
					message: JSON.stringify({
						event: "cms.descope_auth_rejected",
						code: "issuer_mismatch",
					}),
				},
				{
					message: [
						JSON.stringify({
							event: "cms.descope_auth_rejected",
							code: "issuer_mismatch",
						}),
					],
				},
			]),
		).toEqual(["jwt_validation:ERR_JWT_EXPIRED", "issuer_mismatch"]);
	});

	it("discards arbitrary tenant messages, events, and unrecognized code suffixes", () => {
		expect(
			cmsAuthRejectionCodes([
				{ message: "private@example.com secret" },
				{
					message: JSON.stringify({
						event: "untrusted",
						code: "missing_session",
					}),
				},
				{
					message: JSON.stringify({
						event: "cms.descope_auth_rejected",
						code: "jwt_validation:private@example.com",
					}),
				},
				{
					message: JSON.stringify({
						event: "cms.descope_auth_rejected",
						code: "missing_session private-secret",
					}),
				},
				{ message: JSON.stringify(null) },
				{
					message: JSON.stringify({
						event: "cms.descope_auth_rejected",
						code: 401,
					}),
				},
				{
					message: {
						event: "cms.descope_auth_rejected",
						code: "missing_session",
					},
				},
			]),
		).toEqual([]);
	});
});
