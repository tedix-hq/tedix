import * as appRecords from "@tedix/db/queries/app-records";
import * as organizations from "@tedix/db/queries/organizations";
import { createRouterClient } from "@orpc/server";
import { describe, expect, it, vi } from "vite-plus/test";
import * as instanceQueries from "@tedix/db/queries/connection-instances";
import * as connectionAuth from "@tedix/auth/connections";
import type { BaseContext } from "../orpc";
import { connectionsContractRouter } from "./connections";
import { fetchNamedConnection } from "./connections/policy-resolution";

const TEDI_ID = "0b90b0e2-14da-4a34-bd35-a416ab604f25";

function userContext(permissions: string[]): BaseContext {
	return {
		authType: "user",
		db: {} as BaseContext["db"],
		env: { ENVIRONMENT: "test" } as CloudflareEnv,
		headers: new Headers(),
		organizationId: "org-1",
		url: new URL("https://api.tedix.test/rpc/connections"),
		user: {
			aud: "test",
			dct: "tenant-1",
			exp: 2,
			iat: 1,
			iss: "https://auth.tedix.test",
			permissions,
			roles: [],
			sub: "user-1",
		},
	} as BaseContext;
}

function apiKeyContext(scopes: string[]): BaseContext {
	return {
		apiKey: {
			id: "key-1",
			name: "test",
			organizationId: "org-1",
			scopes,
		},
		authType: "apikey",
		db: {} as BaseContext["db"],
		env: { ENVIRONMENT: "test" } as CloudflareEnv,
		headers: new Headers(),
		organizationId: "org-1",
		url: new URL("https://api.tedix.test/rpc/connections"),
	} as BaseContext;
}

describe("connections authorization-plane composition", () => {
	it("requires a human owner for named personal account lifecycle", async () => {
		const client = createRouterClient(connectionsContractRouter, {
			context: apiKeyContext(["apps:read"]),
		});
		await expect(
			client.createConnectionInstance({
				appId: "microsoft",
				label: "Business",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});
	it("does not allow app-read users to bind a shared installed app", async () => {
		const client = createRouterClient(connectionsContractRouter, {
			context: userContext(["apps:read"]),
		});
		await expect(
			client.bindConnectionInstance({
				appId: TEDI_ID,
				providerId: "microsoft",
				connectionInstanceId: TEDI_ID,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it.each([
		"createConnectionInstance",
		"renameConnectionInstance",
		"preparePersonalConnection",
	] as const)(
		"requires integration management for tenant %s",
		async (method) => {
			const client = createRouterClient(connectionsContractRouter, {
				context: userContext(["apps:read"]),
			});
			const input = {
				id: TEDI_ID,
				appId: "microsoft",
				label: "Shared",
				scope: "tenant" as const,
				connectionInstanceId: TEDI_ID,
			};
			await expect(client[method](input)).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
		},
	);
	it("authorizes the exact organization before preparing a named account", async () => {
		const lookup = vi
			.spyOn(instanceQueries, "getConnectionInstance")
			.mockResolvedValue(undefined);
		try {
			const client = createRouterClient(connectionsContractRouter, {
				context: userContext(["apps:read", "integrations:manage"]),
			});
			await expect(
				client.preparePersonalConnection({
					appId: "microsoft",
					connectionInstanceId: TEDI_ID,
					scope: "tenant",
				}),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			expect(lookup).toHaveBeenCalledWith(
				expect.anything(),
				{ organizationId: "org-1" },
				TEDI_ID,
				"microsoft",
			);
		} finally {
			lookup.mockRestore();
		}
	});
	it("rejects foreign account slots before creating an OAuth handoff", async () => {
		const lookup = vi
			.spyOn(instanceQueries, "getConnectionInstance")
			.mockResolvedValue(undefined);
		try {
			const client = createRouterClient(connectionsContractRouter, {
				context: userContext(["apps:read"]),
			});
			await expect(
				client.preparePersonalConnection({
					appId: "microsoft",
					connectionInstanceId: TEDI_ID,
				}),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			expect(lookup).toHaveBeenCalledWith(
				expect.anything(),
				{ userId: "user-1" },
				TEDI_ID,
				"microsoft",
			);
		} finally {
			lookup.mockRestore();
		}
	});
	it.each([
		["user", "subject-a"],
		["tenant", "subject-a"],
		["user", undefined],
		["tenant", undefined],
	] as const)(
		"disconnects only the exact %s slot grant IDs with subject %s",
		async (scope, tokenSub) => {
			const instance = {
				id: TEDI_ID,
				ownerUserId: "user-1",
				organizationId: scope === "tenant" ? "org-1" : null,
				providerId: "microsoft",
				label: "Business",
				tokenIds: ["own-old", "own-current"],
				tokenSub: tokenSub ?? null,
				createdAt: "now",
				updatedAt: "now",
			};
			const lookup = vi
				.spyOn(instanceQueries, "getConnectionInstance")
				.mockResolvedValue(instance);
			const clear = vi
				.spyOn(instanceQueries, "clearConnectionGrants")
				.mockResolvedValue([instance]);
			const fetchToken = vi
				.spyOn(
					connectionAuth,
					scope === "user"
						? "fetchPersonalConnectionToken"
						: "fetchNamedTenantConnectionToken",
				)
				.mockResolvedValueOnce({
					id: "own-current",
					accessToken: "opaque",
					tokenSub,
					scopes: [],
				})
				.mockResolvedValueOnce({
					id: "own-unobserved-scope",
					accessToken: "opaque",
					tokenSub,
					scopes: [],
				})
				.mockResolvedValue(null);
			const orgLookup = vi
				.spyOn(organizations, "getOrganizationById")
				.mockResolvedValue({ descopeTenantId: "org_descope_1" } as NonNullable<
					Awaited<ReturnType<typeof organizations.getOrganizationById>>
				>);
			const deleted: string[] = [];
			const fetchSpy = vi
				.spyOn(globalThis, "fetch")
				.mockImplementation(async (input, init) => {
					const request =
						input instanceof Request ? input : new Request(input, init);
					if (request.method === "DELETE") {
						expect(new URL(request.url).searchParams.has("id")).toBe(true);
						deleted.push(new URL(request.url).searchParams.get("id")!);
					}
					return Response.json({});
				});
			try {
				const context = userContext(["apps:read", "integrations:manage"]);
				context.env = {
					DESCOPE_PROJECT_ID: "test-project",
					DESCOPE_MANAGEMENT_KEY: "test-key",
				} as CloudflareEnv;
				const client = createRouterClient(connectionsContractRouter, {
					context,
				});
				await expect(
					client.disconnectProvider({
						appId: "microsoft",
						tokenScope: scope,
						connectionInstanceId: TEDI_ID,
					}),
				).resolves.toMatchObject({ success: true });
				expect(deleted).toEqual([
					"own-old",
					"own-current",
					"own-unobserved-scope",
				]);
				expect(clear).toHaveBeenCalledWith(
					context.db,
					scope === "user" ? { userId: "user-1" } : { organizationId: "org-1" },
					TEDI_ID,
				);
			} finally {
				lookup.mockRestore();
				clear.mockRestore();
				fetchToken.mockRestore();
				fetchSpy.mockRestore();
				orgLookup.mockRestore();
			}
		},
	);

	it.each(["discovery failure", "aggregate failure", "success"])(
		"activates a tenant wrapper binding with strict cache receipts: %s",
		async (mode) => {
			const lookup = vi
				.spyOn(instanceQueries, "getConnectionInstance")
				.mockResolvedValue({ id: TEDI_ID } as NonNullable<
					Awaited<ReturnType<typeof instanceQueries.getConnectionInstance>>
				>);
			const appLookup = vi
				.spyOn(appRecords, "getAppByIdForOrganization")
				.mockResolvedValue({ id: TEDI_ID, slug: "wrapper" } as NonNullable<
					Awaited<ReturnType<typeof appRecords.getAppByIdForOrganization>>
				>);
			const metadata = vi
				.spyOn(appRecords, "getAppMetadataJson")
				.mockReturnValue({
					mcpConfig: {
						connectionProviderId: "microsoft",
						aggregateApps: [{ slug: "base", connectionScope: "user" }],
					},
				});
			const save = vi
				.spyOn(appRecords, "updateAppMetadata")
				.mockResolvedValue(undefined);
			const requests: string[] = [];
			const context = userContext(["apps:update", "integrations:manage"]);
			context.env = {
				MCP_SERVICE: {
					fetch: vi.fn(async (request: Request) => {
						requests.push(request.url);
						return Response.json({
							ok:
								mode === "success" ||
								(mode === "aggregate failure" &&
									!request.url.includes("purge-aggregate")),
						});
					}),
				},
			} as unknown as CloudflareEnv;
			try {
				const client = createRouterClient(connectionsContractRouter, {
					context,
				});
				const call = client.bindConnectionInstance({
					appId: TEDI_ID,
					providerId: "microsoft",
					connectionInstanceId: TEDI_ID,
					scope: "tenant",
				});
				if (mode === "success")
					await expect(call).resolves.toEqual({ success: true });
				else
					await expect(call).rejects.toMatchObject({
						code: "SERVICE_UNAVAILABLE",
					});
				expect(save).toHaveBeenCalledWith(
					context.db,
					TEDI_ID,
					expect.objectContaining({
						mcpConfig: expect.objectContaining({
							connectionScope: "tenant",
							connectionInstanceId: TEDI_ID,
						}),
					}),
				);
				expect(requests).toEqual(
					mode === "discovery failure"
						? ["https://internal/__internal/purge-discovery-cache"]
						: [
								"https://internal/__internal/purge-discovery-cache",
								"https://internal/__internal/purge-aggregate-cache",
							],
				);
			} finally {
				lookup.mockRestore();
				appLookup.mockRestore();
				metadata.mockRestore();
				save.mockRestore();
			}
		},
	);
	it("requires apps:read on both planes for public connection discovery", async () => {
		const userClient = createRouterClient(connectionsContractRouter, {
			context: userContext([]),
		});
		const apiKeyClient = createRouterClient(connectionsContractRouter, {
			context: apiKeyContext([]),
		});

		await expect(userClient.listProviders({})).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(apiKeyClient.getUserConnections({})).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});

	it("does not treat ordinary app-read authority as tedi-read authority", async () => {
		const userClient = createRouterClient(connectionsContractRouter, {
			context: userContext(["apps:read"]),
		});
		const apiKeyClient = createRouterClient(connectionsContractRouter, {
			context: apiKeyContext(["apps:read"]),
		});

		await expect(
			userClient.getTediConnections({ tediId: TEDI_ID }),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(
			apiKeyClient.getTediConnections({ tediId: TEDI_ID }),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});

	it("allows a member to manage only their own OAuth credential", async () => {
		const memberClient = createRouterClient(connectionsContractRouter, {
			context: userContext(["apps:read"]),
		});

		// The test context has no Descope management key, so reaching the
		// handler fails internally after authorization. That is intentional: it
		// proves the member crossed the personal-credential guard without giving
		// the test a real credential store.
		await expect(
			memberClient.disconnectProvider({
				appId: "provider-1",
				tokenScope: "user",
			}),
		).rejects.not.toMatchObject({ code: "FORBIDDEN" });

		await expect(
			memberClient.disconnectProvider({
				appId: "provider-1",
				tokenScope: "tenant",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("reserves raw provider tokens for platform-authorized principals", async () => {
		const userClient = createRouterClient(connectionsContractRouter, {
			context: userContext(["apps:read", "integrations:manage"]),
		});
		const apiKeyClient = createRouterClient(connectionsContractRouter, {
			context: apiKeyContext(["apps:read"]),
		});

		await expect(
			userClient.fetchToken({ providerId: "provider-1" }),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(
			apiKeyClient.fetchOrgToken({
				organizationId: "org-1",
				providerId: "provider-1",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			apiKeyClient.fetchTediToken({
				tediId: TEDI_ID,
				providerId: "provider-1",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("reserves the project-wide provider audit for platform authority", async () => {
		const userClient = createRouterClient(connectionsContractRouter, {
			context: userContext(["apps:read"]),
		});
		const apiKeyClient = createRouterClient(connectionsContractRouter, {
			context: apiKeyContext(["apps:read"]),
		});

		await expect(userClient.auditProviderSettings({})).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(apiKeyClient.auditProviderSettings({})).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});
});

// Native Descope account selectors remain authoritative when identity metadata is absent.
describe("named credential identity evidence", () => {
	it.each(["user", "tenant"] as const)(
		"records subjectless %s grants and pins late identity on the same grant",
		async (scope) => {
			const instance = {
				id: TEDI_ID,
				ownerUserId: "user-1",
				organizationId: scope === "tenant" ? "org-1" : null,
				providerId: "google-calendar",
				label: "Account",
				tokenIds: [] as string[],
				tokenSub: null as string | null,
				createdAt: "now",
				updatedAt: "now",
			};
			const lookup = vi
				.spyOn(instanceQueries, "getConnectionInstance")
				.mockResolvedValue(instance);
			const record = vi
				.spyOn(instanceQueries, "recordConnectionGrant")
				.mockResolvedValue([instance]);
			const fetch = vi
				.spyOn(
					connectionAuth,
					scope === "user"
						? "fetchPersonalConnectionToken"
						: "fetchNamedTenantConnectionToken",
				)
				.mockResolvedValue({
					id: "native-grant",
					accessToken: "opaque",
					scopes: [],
				});
			const owner =
				scope === "user"
					? { userId: "user-1" }
					: { organizationId: "org-1", tenantId: "org_descope_1" };
			const context = userContext(["integrations:manage"]);
			try {
				expect(
					await fetchNamedConnection(
						context,
						owner,
						"google-calendar",
						TEDI_ID,
					),
				).toMatchObject({ id: "native-grant" });
				expect(record).toHaveBeenCalledWith(
					context.db,
					expect.objectContaining({
						owner,
						providerId: "google-calendar",
						id: TEDI_ID,
						tokenId: "native-grant",
						tokenSub: undefined,
					}),
				);
				instance.tokenIds = ["native-grant"];
				record.mockClear();
				await fetchNamedConnection(context, owner, "google-calendar", TEDI_ID);
				expect(record).not.toHaveBeenCalled();
				fetch.mockResolvedValue({
					id: "native-grant",
					accessToken: "opaque",
					tokenSub: "identity-a",
					scopes: [],
				});
				await fetchNamedConnection(context, owner, "google-calendar", TEDI_ID);
				expect(record).toHaveBeenCalledWith(
					context.db,
					expect.objectContaining({
						tokenId: "native-grant",
						tokenSub: "identity-a",
					}),
				);
				record.mockResolvedValue([]);
				await expect(
					fetchNamedConnection(context, owner, "google-calendar", TEDI_ID),
				).rejects.toMatchObject({ code: "CONFLICT" });
				instance.tokenSub = "identity-a";
				for (const tokenSub of [undefined, "identity-b"]) {
					fetch.mockResolvedValue({
						id: "native-grant",
						accessToken: "opaque",
						tokenSub,
						scopes: [],
					});
					await expect(
						fetchNamedConnection(context, owner, "google-calendar", TEDI_ID),
					).rejects.toMatchObject({ code: "CONFLICT" });
				}
			} finally {
				lookup.mockRestore();
				record.mockRestore();
				fetch.mockRestore();
			}
		},
	);
});
