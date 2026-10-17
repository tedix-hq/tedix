// @vitest-environment node
import { describe, it, expect } from "vite-plus/test";
import {
	handleOidcBroker,
	proxyOidcProtocol,
	oidcSessionMatchesTenant,
} from "./oidc";
const request = (path: string, headers: Record<string, string> = {}) =>
	new Request(`https://acme.example.test${path}`, { headers });
describe("OS OIDC boundary", () => {
	it("binds organization selection to the host and strips internal authority headers", async () => {
		const api = {
			fetch: async (r: Request) => {
				expect(new URL(r.url).searchParams.get("organization")).toBe("acme");
				expect(r.headers.get("X-Service-Binding")).toBeNull();
				expect(r.headers.get("Authorization")).toBeNull();
				expect(r.headers.get("X-Tedix-Tenant-Id")).toBe("acme");
				return new Response(null, { status: 302 });
			},
		};
		expect(
			(
				await proxyOidcProtocol(
					request("/auth/oidc/start?organization=other", {
						"X-Service-Binding": "true",
						Authorization: "Bearer attacker",
					}),
					api,
					"acme",
				)
			).status,
		).toBe(302);
	});
	it("requires a verified API session before admitting a tenant document", async () => {
		const req = request("/", { Cookie: "__Host-tedix-oidc=opaque" });
		expect(
			await oidcSessionMatchesTenant(
				req,
				{ fetch: async () => Response.json({ organizationId: "other" }) },
				"acme",
			),
		).toBe(false);
		expect(
			await oidcSessionMatchesTenant(
				req,
				{ fetch: async () => new Response(null, { status: 401 }) },
				"acme",
			),
		).toBe(false);
		expect(
			await oidcSessionMatchesTenant(
				req,
				{ fetch: async () => Response.json({ organizationId: "acme" }) },
				"acme",
			),
		).toBe(true);
	});
	it("preserves the shell status contract and uses OIDC for renewal", async () => {
		const api = {
			fetch: async () =>
				Response.json({
					expiresAt: 9999999999,
					user: { email: "alice@example.test", name: "Alice" },
				}),
		};
		expect(
			await (await handleOidcBroker(
				request("/auth/session-broker/status"),
				api,
				"acme",
			))!.json(),
		).toMatchObject({
			authenticated: true,
			tenantId: "acme",
			user: { name: "Alice" },
		});
		expect(
			(await handleOidcBroker(
				request("/auth/session-broker/start"),
				api,
				"acme",
			))!.headers.get("Location"),
		).toContain("/auth/oidc/start?organization=acme");
	});
	it("refuses cross-site logout", async () => {
		const api = {
			fetch: async () => {
				throw new Error("must not call");
			},
		};
		expect(
			(await handleOidcBroker(
				request("/auth/session-broker/start?operation=logout", {
					"Sec-Fetch-Site": "cross-site",
				}),
				api,
				"acme",
			))!.status,
		).toBe(403);
	});
});
