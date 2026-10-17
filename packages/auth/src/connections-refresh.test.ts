import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	fetchConnectionToken,
	fetchConnectionTokenByScopes,
	fetchTenantConnectionToken,
	fetchTenantConnectionTokenByScopes,
	fetchPersonalConnectionToken,
	fetchNamedTenantConnectionToken,
} from "./connections";

afterEach(() => vi.restoreAllMocks());

const fetchers = [
	[
		"fetchToken",
		(client: Parameters<typeof fetchConnectionToken>[0]) =>
			fetchConnectionToken(client, "mail", "owner"),
	],
	[
		"fetchTokenByScopes",
		(client: Parameters<typeof fetchConnectionToken>[0]) =>
			fetchConnectionTokenByScopes(client, "mail", "owner", ["read"]),
	],
	[
		"fetchTenantToken",
		(client: Parameters<typeof fetchConnectionToken>[0]) =>
			fetchTenantConnectionToken(client, "mail", "tenant"),
	],
	[
		"fetchTenantTokenByScopes",
		(client: Parameters<typeof fetchConnectionToken>[0]) =>
			fetchTenantConnectionTokenByScopes(client, "mail", "tenant", ["read"]),
	],
] as const;

describe.each(fetchers)("%s refresh health", (method, fetchToken) => {
	it.each([
		[
			{
				lastRefreshError: "provider error with secret",
				accessTokenExpiry: "4102444800",
			},
			true,
		],
		[{ lastRefreshError: "invalid_grant", accessToken: "" }, true],
		[{ lastRefreshTime: "100", accessTokenExpiry: "200" }, true],
		[
			{
				lastRefreshTime: "100",
				accessTokenExpiry: "4102444800",
				lastRefreshError: "",
			},
			false,
		],
		[{ accessTokenExpiry: "200" }, false],
		[{ lastRefreshTime: "bad", accessTokenExpiry: "200" }, false],
		[{ lastRefreshTime: "0", accessTokenExpiry: "200" }, false],
		[{ lastRefreshTime: "100", accessTokenExpiry: "bad" }, false],
	])("classifies documented metadata %j", async (metadata, reconnect) => {
		const sdkFetch = vi.fn(async () => ({
			ok: true,
			data: {
				id: "grant",
				accessToken: "opaque",
				scopes: ["read"],
				...metadata,
			},
		}));
		const client = {
			management: { outboundApplication: { [method]: sdkFetch } },
		} as unknown as Parameters<typeof fetchConnectionToken>[0];
		const token = await fetchToken(client);
		expect(token?.reconnectNeeded === true).toBe(reconnect);
		expect(token).not.toHaveProperty("lastRefreshError");
		expect(token).not.toHaveProperty("refreshToken");
		expect(sdkFetch).toHaveBeenCalledTimes(1);
	});
});

it.each([false, true])(
	"preserves reconnect health for named grants (tenant=%s)",
	async (tenant) => {
		const selection = { appId: "mail", externalIdentifier: "slot" };
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					token: {
						id: "grant",
						...selection,
						...(tenant ? { tenantId: "tenant" } : { userId: "owner" }),
						accessToken: "",
						lastRefreshError: "invalid_grant",
						scopes: ["read"],
					},
				}),
				{ headers: { "Content-Type": "application/json" } },
			),
		);
		const env = {
			DESCOPE_PROJECT_ID: "project",
			DESCOPE_MANAGEMENT_KEY: "key",
		};
		const token = tenant
			? await fetchNamedTenantConnectionToken(env, {
					...selection,
					tenantId: "tenant",
				})
			: await fetchPersonalConnectionToken(env, {
					...selection,
					userId: "owner",
				});
		expect(token).toMatchObject({ reconnectNeeded: true, accessToken: "" });
		expect(token).not.toHaveProperty("lastRefreshError");
	},
);
