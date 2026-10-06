// @vitest-environment node
import { describe, expect, it, vi } from "vite-plus/test";
import type { OsRouterEnv } from "../worker";
import { OS_BROKER_SESSION_COOKIE } from "../auth/session-broker";
import {
	handleProviderCohortHost,
	PROVIDER_COHORT_PATH,
	PROVIDER_COHORT_SESSION_PATH,
} from "./provider-cohort-host";

const origin = "https://tedix.os.tedix.dev";
const target = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const conversationId = "11111111-1111-4111-8111-111111111111";
const cookie = `${OS_BROKER_SESSION_COOKIE}=signed-session`;
const env = {
	API_SERVICE: { fetch: vi.fn(async () => Response.json({})) },
	DESCOPE_PROJECT_ID: "test-project",
	PROVIDER_COHORT_OS_TENANT_ID: "org_tedix",
	PROVIDER_COHORT_EXTERNAL_TENANT_ID: target,
	TEDIX_PROVIDER_COHORT_API_KEY: "sk_test_cohort",
} satisfies Partial<OsRouterEnv>;
const verify = vi.fn(async () => ({
	sub: "user_tedix",
	dct: "org_tedix",
})) as never;

function post(body: unknown, headers: Record<string, string> = {}) {
	return new Request(`${origin}${PROVIDER_COHORT_SESSION_PATH}`, {
		method: "POST",
		headers: {
			Cookie: cookie,
			Origin: origin,
			Referer: `${origin}${PROVIDER_COHORT_PATH}`,
			"Content-Type": "application/json",
			...headers,
		},
		body: JSON.stringify(body),
	});
}

describe("first-party Jev provider cohort host", () => {
	it("serves a dedicated page only after verified tenant-bound login", async () => {
		const response = await handleProviderCohortHost(
			new Request(`${origin}${PROVIDER_COHORT_PATH}`, {
				headers: { Cookie: cookie },
			}),
			env,
			"org_tedix",
			verify,
		);
		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain(
			'data-tedix-endpoint="/jev-provider-cohort/session"',
		);
		expect(html).toContain('"routeKey":"jev_provider_cohort"');
		expect(html).toContain(
			'addEventListener("pagehide",()=>window.Tedix?.shutdown())',
		);
		expect(html).not.toContain("sk_test_cohort");
		const inline = /<script>(.*?)<\/script>/.exec(html)?.[1];
		expect(inline).toBeTruthy();
		const handlers = new Map<string, () => void>();
		const shutdown = vi.fn();
		new Function("addEventListener", "window", inline!)(
			(name: string, handler: () => void) => handlers.set(name, handler),
			{ Tedix: { shutdown } },
		);
		handlers.get("pagehide")?.();
		expect(shutdown).toHaveBeenCalledOnce();
	});

	it("derives the exact target and route server-side and selects API-key auth", async () => {
		const exchange = vi.fn(async () => ({
			token: "browser-token",
			expiresAt: Date.now() + 60_000,
		}));
		const response = await handleProviderCohortHost(
			post({ conversationId, pathname: PROVIDER_COHORT_PATH }),
			env,
			"org_tedix",
			verify,
			exchange as never,
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ token: "browser-token" });
		expect(exchange).toHaveBeenCalledWith(
			"tedis/createEmbeddedProviderSession",
			{
				externalTenantId: target,
				hostUserId: "user_tedix",
				conversationId,
				portableRouteAssertion: {
					routeId: "jev_provider_cohort",
					pathname: PROVIDER_COHORT_PATH,
					routeKey: "jev_provider_cohort",
				},
			},
			expect.objectContaining({
				apiUrl: "https://api.tedix.dev",
				headers: { "X-API-Key": "sk_test_cohort" },
			}),
		);
	});

	it("rejects forged route and tenant authority before exchange", async () => {
		const exchange = vi.fn();
		for (const body of [
			{ conversationId, pathname: "/workspaces" },
			{ conversationId, routeId: "workspaces" },
			{ conversationId, externalTenantId: "other" },
			{ conversationId, hostUserId: "other" },
			{ conversationId, portableRouteAssertion: { routeId: "other" } },
		]) {
			const response = await handleProviderCohortHost(
				post(body),
				env,
				"org_tedix",
				verify,
				exchange as never,
			);
			expect(response.status).toBe(400);
		}
		expect(exchange).not.toHaveBeenCalled();
	});

	it("rejects expired and cross-tenant signed sessions", async () => {
		const exchange = vi.fn();
		const expired = vi.fn(async () => {
			throw new Error("expired");
		}) as never;
		const wrongTenant = vi.fn(async () => ({
			sub: "user_tedix",
			dct: "org_other",
		})) as never;
		expect(
			(
				await handleProviderCohortHost(
					post({ conversationId }),
					env,
					"org_tedix",
					expired,
					exchange as never,
				)
			).status,
		).toBe(401);
		expect(
			(
				await handleProviderCohortHost(
					post({ conversationId }),
					env,
					"org_tedix",
					wrongTenant,
					exchange as never,
				)
			).status,
		).toBe(403);
		expect(exchange).not.toHaveBeenCalled();
	});

	it("fails closed on cross-host, cross-tenant, cross-origin and wrong page", async () => {
		const exchange = vi.fn();
		const body = { conversationId };
		const cases = [
			[
				new Request(`https://other.os.tedix.dev${PROVIDER_COHORT_PATH}`, {
					headers: { Cookie: cookie },
				}),
				env,
				"org_tedix",
			],
			[post(body), env, "other"],
			[post(body, { Origin: "https://evil.example" }), env, "org_tedix"],
			[post(body, { Referer: `${origin}/workspaces` }), env, "org_tedix"],
			[
				post(body),
				{ ...env, PROVIDER_COHORT_OS_TENANT_ID: "other" },
				"org_tedix",
			],
		] as const;
		for (const [request, selectedEnv, hostTenantId] of cases) {
			const response = await handleProviderCohortHost(
				request,
				selectedEnv,
				hostTenantId,
				verify,
				exchange as never,
			);
			expect([403, 404]).toContain(response.status);
		}
		expect(exchange).not.toHaveBeenCalled();
	});

	it("requires a verified login and a configured exact-scope key", async () => {
		const exchange = vi.fn();
		const noSession = await handleProviderCohortHost(
			new Request(`${origin}${PROVIDER_COHORT_SESSION_PATH}`, {
				method: "POST",
				headers: {
					Origin: origin,
					Referer: `${origin}${PROVIDER_COHORT_PATH}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ conversationId }),
			}),
			env,
			"org_tedix",
			verify,
			exchange as never,
		);
		expect(noSession.status).toBe(401);
		const missingKey = await handleProviderCohortHost(
			post({ conversationId }),
			{
				...env,
				TEDIX_PROVIDER_COHORT_API_KEY: undefined,
			},
			"org_tedix",
			verify,
			exchange as never,
		);
		expect(missingKey.status).toBe(503);
		expect(exchange).not.toHaveBeenCalled();
	});

	it("uses API-key auth over the binding without service-binding authority", async () => {
		let upstream: Request | undefined;
		const apiService = {
			fetch: async (request: Request) => {
				upstream = request;
				return Response.json({ error: "test denial" }, { status: 403 });
			},
		};
		const response = await handleProviderCohortHost(
			post({ conversationId }),
			{
				...env,
				API_SERVICE: apiService,
			},
			"org_tedix",
			verify,
		);
		expect(response.status).toBe(403);
		expect(upstream?.url).toBe(
			"https://api.tedix.dev/rpc/tedis/createEmbeddedProviderSession",
		);
		expect(upstream?.headers.get("X-API-Key")).toBe("sk_test_cohort");
		expect(upstream?.headers.has("X-Service-Binding")).toBe(false);
		expect(upstream?.headers.has("Cookie")).toBe(false);
	});
});
