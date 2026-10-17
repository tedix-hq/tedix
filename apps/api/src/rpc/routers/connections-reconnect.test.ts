import { createRouterClient } from "@orpc/server";
import * as authClient from "@tedix/auth/client";
import * as providers from "@tedix/db/queries/connection-providers";
import * as organizations from "@tedix/db/queries/organizations";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { connectionsContractRouter } from "./connections";

afterEach(() => vi.restoreAllMocks());

it.each([
	[
		{
			lastRefreshError: "secret invalid_grant",
			accessTokenExpiry: "4102444800",
		},
		"reconnect_needed",
	],
	[
		{ lastRefreshError: "secret invalid_grant", accessToken: "" },
		"reconnect_needed",
	],
	[{ lastRefreshTime: "100", accessTokenExpiry: "200" }, "reconnect_needed"],
	[
		{
			lastRefreshTime: "100",
			accessTokenExpiry: "4102444800",
			lastRefreshError: "",
		},
		"connected",
	],
	[{ accessTokenExpiry: "200" }, "expired"],
] as const)(
	"get_user_connections projects refresh metadata %j",
	async (metadata, status) => {
		const app = {
			id: "mail",
			name: "Mail",
			authorizationUrl: "https://mail.example/authorize",
		};
		const token = { accessToken: "opaque", scopes: ["read"], ...metadata };
		const fetchToken = vi.fn(async () => ({ ok: true, data: token }));
		vi.spyOn(authClient, "getManagementClient").mockReturnValue({
			management: {
				outboundApplication: {
					loadAllApplications: async () => ({ ok: true, data: [app] }),
					listAppsWithUserToken: async () => ({ ok: true, data: [app.id] }),
					fetchToken,
					fetchTenantToken: fetchToken,
				},
			},
		} as never);
		vi.spyOn(organizations, "getOrganizationById").mockResolvedValue({
			descopeTenantId: "tenant",
		} as never);
		vi.spyOn(providers, "listConnectionProviders").mockResolvedValue([]);
		const client = createRouterClient(connectionsContractRouter, {
			context: {
				authType: "user",
				organizationId: "org",
				db: {},
				headers: new Headers(),
				env: { DESCOPE_PROJECT_ID: "project", DESCOPE_MANAGEMENT_KEY: "key" },
				user: { sub: "owner", permissions: ["apps:read"], roles: [] },
			} as BaseContext,
		});
		const result = await client.getUserConnections({});
		expect(result.data).toHaveLength(2);
		expect(result.data.map((row) => row.status)).toEqual([status, status]);
		expect(JSON.stringify(result)).not.toMatch(
			/opaque|secret|lastRefreshError|accessToken/,
		);
		expect(fetchToken).toHaveBeenCalledWith("mail", "owner", undefined, {
			forceRefresh: false,
		});
	},
);
