import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { OsSessionBroker } from "./index";
import type { BrokerEnv } from "./env";

const customHost = { organizationId: "org-acme", tenantId: "T-acme" };
const targetOrigin = "https://share.example.com";
const stateHash = `sha256-${"a".repeat(43)}`;
const codeHash = `sha256-${"b".repeat(43)}`;

function api(claim: Record<string, unknown>) {
	return {
		fetch: vi.fn(async (request: Request) => {
			expect(new URL(request.url).pathname).toBe(
				"/rpc/osTenant/resolveHostname",
			);
			expect(request.headers.get("X-Service-Binding")).toBe("true");
			expect(request.headers.get("Authorization")).toBeNull();
			expect(request.headers.get("Cookie")).toBeNull();
			expect(await request.json()).toEqual({
				json: { hostname: "share.example.com" },
			});
			return claim.unavailable
				? new Response("Unavailable", { status: 503 })
				: Response.json({ json: claim });
		}),
	};
}
const active = {
	provisioned: true,
	organizationId: customHost.organizationId,
	descopeTenantId: customHost.tenantId,
};

async function create(service = api(active)) {
	const broker = new OsSessionBroker(createExecutionContext(), {
		...env,
		API_SERVICE: service,
	} as BrokerEnv);
	const created = await broker.createIntent({
		customHost,
		targetOrigin,
		stateHash,
		operation: "issue_session",
		redirectPath: "/s/permanent-link",
		tenantId: customHost.tenantId,
	});
	return { created, service, broker };
}

describe("custom-host broker authorization", () => {
	it("checks the fresh service claim before creating an intent", async () => {
		const { created, service } = await create();
		expect(service.fetch).toHaveBeenCalledTimes(1);
		const pending = await env.SESSION_INTENTS.getByName(
			created.intentId,
		).readPending();
		expect(pending?.customHost).toEqual(customHost);
		expect(pending?.redirectPath).toBe("/s/permanent-link");
	});

	it.each([
		{ provisioned: false, organizationId: null, descopeTenantId: null },
		{ ...active, organizationId: "org-other" },
		{ ...active, descopeTenantId: "T-other" },
		{ ...active, identityProvider: "oidc" },
	])(
		"refuses creation when claim is not an exact active match: %j",
		async (claim) => {
			await expect(create(api(claim))).rejects.toThrow(
				"claim no longer matches",
			);
		},
	);

	it.each([
		active,
		{ unavailable: true },
		{ provisioned: false, organizationId: null, descopeTenantId: null },
		{ ...active, organizationId: "org-other" },
		{ ...active, descopeTenantId: "T-other" },
	])(
		"rechecks the stored claim at exchange and consumes only a matching grant: %j",
		async (claim) => {
			const { created } = await create();
			const stub = env.SESSION_INTENTS.getByName(created.intentId);
			await stub.storeSessionGrant({
				codeHash,
				codeExpiresAt: Math.floor(Date.now() / 1000) + 30,
				sessionExpiresAt: Math.floor(Date.now() / 1000) + 600,
				sessionJwt: "secret-session",
				subject: "user-acme",
				tenantId: customHost.tenantId,
			});
			await runInDurableObject(stub, async (instance) => {
				const service = api(claim);
				const original = instance["env"].API_SERVICE;
				instance["env"].API_SERVICE = service as typeof original;
				try {
					const input = {
						customHost,
						targetOrigin,
						stateHash,
						tenantId: customHost.tenantId,
						intentId: created.intentId,
						code: "c".repeat(43),
					};
					if (claim === active) {
						for (const binding of [
							{ ...customHost, organizationId: "org-other" },
							{ ...customHost, tenantId: "T-other" },
						]) {
							expect(
								await instance.exchange(
									{ ...input, customHost: binding },
									"os",
									codeHash,
								),
							).toBeNull();
						}
						service.fetch.mockClear();
					}
					const result = await instance.exchange(input, "os", codeHash);
					expect(service.fetch).toHaveBeenCalledTimes(1);
					if (claim === active) {
						expect(result).toMatchObject({
							kind: "session",
							tenantId: customHost.tenantId,
							sessionJwt: "secret-session",
						});
					} else expect(result).toBeNull();
					expect(await instance.exchange(input, "os", codeHash)).toBeNull();
				} finally {
					instance["env"].API_SERVICE = original;
				}
			});
		},
	);

	it("fails closed on service failure", async () => {
		const service = {
			fetch: vi.fn(async () => new Response("Unavailable", { status: 503 })),
		};
		const broker = new OsSessionBroker(createExecutionContext(), {
			...env,
			API_SERVICE: service,
		} as BrokerEnv);
		await expect(
			broker.createIntent({
				customHost,
				targetOrigin,
				stateHash,
				operation: "issue_session",
				redirectPath: "/s/permanent-link",
				tenantId: customHost.tenantId,
			}),
		).rejects.toThrow();
		expect(service.fetch).toHaveBeenCalledTimes(1);
	});
});
