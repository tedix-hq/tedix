import {
	isInventoryProviderVisible,
	summarizeCredential,
} from "./connections/inventory";
import { CreateProviderFromMcpInputSchema } from "@tedix/api-contract/schemas/connections";
import type { DbClient } from "@tedix/db/client";
import type { ConnectionProviderRow } from "@tedix/db/schema/connection-providers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	auditOutboundAppRecord,
	buildCredentialResolutionTargets,
	buildLabeledProviderCandidates,
	buildProviderProvisioning,
	chooseEffectiveConsentScopes,
	collectReferencedProviders,
	composeApiKeyCredential,
	DESCOPE_OUTBOUND_CALLBACK_DOMAIN,
	discoverOutboundAppMetadataForAudit,
	enforceConnectionProviderIssuerPin,
	hasStaticOAuthOutboundAppShape,
	isDescopeDcrRegistrationError,
	normalizeProviderDescription,
	registerMcpOAuthClientForDescope,
	resolveConnectionProviderTemplate,
	resolveCredentialChain,
	resolveProviderLogoUrl,
	resolveTokenPreferringLabel,
} from "./connections/policy-resolution";

const baseArgs = {
	descopeTenantId: "org_descope_1",
	callerUserId: "user_caller_1",
	ownerUserId: "user_owner_1",
	actingUserOwnsOrganization: true,
};

/**
 * Minimal drizzle double, mirroring
 * packages/db/src/queries/connection-providers.test.ts's makeDb, seeded with
 * the handful of real provider rows these tests depend on.
 */
function providerRow(
	overrides: Partial<ConnectionProviderRow>,
): ConnectionProviderRow {
	return {
		id: "example",
		name: "Example",
		description: "",
		icon: "",
		category: "development",
		type: "oauth",
		descopeAppId: null,
		descopeAppAliases: null,
		sortOrder: 0,
		recommendedScope: "user",
		supportedScopes: ["tenant", "user"],
		requiredScopes: [],
		credentialProfile: null,
		oauthConfig: null,
		pinnedIssuer: null,
		authorizationResponseIssSupported: null,
		createdAt: null,
		updatedAt: null,
		...overrides,
	};
}

const PROVIDER_FIXTURES: ConnectionProviderRow[] = [
	// Compound multi-field credential (two inputs joined by a template). Not a
	// real provider.
	providerRow({
		id: "compound-api-key",
		type: "api_key",
		descopeAppId: "compound-api-key",
		supportedScopes: ["tenant"],
		recommendedScope: "tenant",
		credentialProfile: {
			inputFields: [
				{ name: "projectId", label: "Project ID", type: "text" },
				{ name: "managementKey", label: "Management key", type: "password" },
			],
			tokenTemplate: "{projectId}:{managementKey}",
		},
	}),
	providerRow({
		id: "promptwatch-api-key",
		type: "api_key",
		descopeAppId: "promptwatch-api-key",
		descopeAppAliases: ["promptwatch-tedix", "promptwatch-globex"],
		supportedScopes: ["tenant"],
		recommendedScope: "tenant",
		credentialProfile: {
			inputFields: [
				{ name: "apiKey", label: "PromptWatch API key", type: "password" },
			],
			tokenTemplate: "{apiKey}",
		},
	}),
	providerRow({
		id: "google-gmail",
		type: "oauth",
		descopeAppId: "google-gmail",
		supportedScopes: ["tenant", "user"],
		recommendedScope: "user",
		credentialProfile: {
			defaultScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
		},
	}),
	providerRow({
		id: "cloudflare",
		type: "oauth",
		descopeAppId: "cloudflare",
		supportedScopes: ["tenant"],
		recommendedScope: "tenant",
	}),
];

function makeTestDb(
	rows: ConnectionProviderRow[] = PROVIDER_FIXTURES,
): DbClient {
	const node = {
		from: () => node,
		where: () => node,
		orderBy: () => Promise.resolve(rows),
		limit: () => Promise.resolve(rows),
	};
	return { select: () => node } as unknown as DbClient;
}

function makeSequentialReadDb(responses: unknown[][]): DbClient {
	const pending = [...responses];
	const node = {
		from: () => node,
		where: () => Promise.resolve(pending.shift() ?? []),
	};
	return { select: () => node } as unknown as DbClient;
}

describe("connection credential scope resolution", () => {
	it("collects provider references in bounded breadth-first waves", async () => {
		const host = {
			id: "host-app",
			slug: "host",
			metadata: {
				mcpConfig: {
					connectionProviderId: "gmail",
					connectionScopes: ["gmail.readonly"],
					credentialProfile: { defaultScopes: ["gmail.default"] },
					aggregateApps: [
						{
							slug: "base",
							connectionProviderId: "calendar",
							connectionScopes: ["calendar.readonly"],
						},
					],
				},
			},
		};
		const base = {
			id: "base-app",
			slug: "base",
			metadata: {
				mcpConfig: {
					connectionProviderId: "gmail",
					connectionScopes: ["gmail.modify"],
					aggregateApps: [{ slug: "host" }],
				},
			},
		};
		const db = makeSequentialReadDb([
			[host],
			[
				{
					appId: "host-app",
					connectionId: "tool-provider",
				},
			],
			[base],
			[
				{
					appId: "base-app",
					connectionId: "nested-tool",
				},
			],
		]);

		const referenced = await collectReferencedProviders(db, "org-1");

		expect(referenced.complete).toBe(true);
		expect(referenced.references.get("tool-provider")).toEqual([
			{ appId: "host-app", appSlug: "host", source: "tool" },
		]);
		expect([...referenced.ids]).toEqual([
			"gmail",
			"calendar",
			"tool-provider",
			"nested-tool",
		]);
		expect(referenced.connectionScopes.get("gmail")).toEqual([
			"gmail.readonly",
			"gmail.modify",
		]);
		expect(referenced.credentialProfiles.get("gmail")?.defaultScopes).toEqual([
			"gmail.default",
		]);
	});

	it("skips tool queries when resolving consent metadata", async () => {
		const host = {
			id: "host-app",
			slug: "host",
			metadata: {
				mcpConfig: {
					connectionProviderId: "gmail",
					connectionScopes: ["gmail.readonly"],
					aggregateApps: [{ slug: "base" }],
				},
			},
		};
		const base = {
			id: "base-app",
			slug: "base",
			metadata: {
				mcpConfig: {
					connectionProviderId: "gmail",
					connectionScopes: ["gmail.modify"],
				},
			},
		};
		const db = makeSequentialReadDb([[host], [base]]);

		const referenced = await collectReferencedProviders(db, "org-1", {
			includeToolReferences: false,
		});

		expect(referenced.connectionScopes.get("gmail")).toEqual([
			"gmail.readonly",
			"gmail.modify",
		]);
		expect([...referenced.ids]).toEqual(["gmail"]);
	});

	it("resolves provider metadata stored by OpenAPI app provisioning", async () => {
		const base = {
			id: "facturama-base",
			slug: "facturama",
			metadata: {
				mcpConfig: {
					openApiSync: {
						connectionProviderId: "facturama-api-key",
						authScopes: ["invoices:write"],
						credentialProfile: {
							inputFields: [
								{ name: "username", label: "API username", type: "text" },
								{
									name: "password",
									label: "API password",
									type: "password",
								},
							],
							tokenTemplate: "{username}:{password}",
							authTemplate: "Basic {token}",
							authEncoding: "base64",
						},
					},
				},
			},
		};
		const db = makeSequentialReadDb([[base], []]);

		const referenced = await collectReferencedProviders(db, "org-1");

		expect([...referenced.ids]).toEqual(["facturama-api-key"]);
		expect(referenced.connectionScopes.get("facturama-api-key")).toEqual([
			"invoices:write",
		]);
		expect(
			referenced.credentialProfiles.get("facturama-api-key")?.inputFields,
		).toEqual([
			{ name: "username", label: "API username", type: "text", required: true },
			{
				name: "password",
				label: "API password",
				type: "password",
				required: true,
			},
		]);
	});

	it("resolves consent scopes from request, app config, and provider fallbacks", () => {
		const resolve = chooseEffectiveConsentScopes;
		const provider = providerRow({
			requiredScopes: ["provider.required"],
			credentialProfile: { defaultScopes: ["provider.default"] },
		});

		expect(
			resolve({
				requestedScopes: ["requested", "requested"],
				connectionScopes: ["app.scope"],
				provider,
			}),
		).toEqual(["requested"]);
		expect(resolve({ connectionScopes: ["app.scope"], provider })).toEqual([
			"app.scope",
		]);
		expect(
			resolve({
				credentialProfile: { defaultScopes: ["app.default"] },
				provider,
			}),
		).toEqual(["app.default"]);
		expect(resolve({ provider })).toEqual(["provider.default"]);
		expect(
			resolve({
				provider: { ...provider, credentialProfile: undefined },
			}),
		).toEqual(["provider.required"]);
	});

	it("uses only the tenant token target for tenant scope", () => {
		expect(
			buildCredentialResolutionTargets({
				...baseArgs,
				scope: "tenant",
			}),
		).toEqual([{ kind: "tenant", tenantId: "org_descope_1" }]);
	});

	it("uses only the caller's user token target for user scope", () => {
		expect(
			buildCredentialResolutionTargets({
				...baseArgs,
				scope: "user",
			}),
		).toEqual([{ kind: "user", source: "caller", userId: "user_caller_1" }]);
	});

	it("uses user targets before tenant target for hybrid scope", () => {
		expect(
			buildCredentialResolutionTargets({
				...baseArgs,
				scope: "hybrid",
			}),
		).toEqual([
			{ kind: "user", source: "caller", userId: "user_caller_1" },
			{ kind: "user", source: "owner", userId: "user_owner_1" },
			{ kind: "tenant", tenantId: "org_descope_1" },
		]);
	});

	it("honors tenant-first preference for hybrid scope", () => {
		expect(
			buildCredentialResolutionTargets({
				...baseArgs,
				scope: "hybrid",
				preference: "tenant-first",
			}),
		).toEqual([
			{ kind: "tenant", tenantId: "org_descope_1" },
			{ kind: "user", source: "caller", userId: "user_caller_1" },
			{ kind: "user", source: "owner", userId: "user_owner_1" },
		]);
	});

	it("uses tenant-first hybrid resolution for a visiting operator", () => {
		expect(
			buildCredentialResolutionTargets({
				...baseArgs,
				scope: "hybrid",
				actingUserOwnsOrganization: false,
			}),
		).toEqual([
			{ kind: "tenant", tenantId: "org_descope_1" },
			{ kind: "user", source: "owner", userId: "user_owner_1" },
		]);
	});

	it("keeps user-only resolution bound to a visiting operator", () => {
		expect(
			buildCredentialResolutionTargets({
				...baseArgs,
				scope: "user",
				actingUserOwnsOrganization: false,
			}),
		).toEqual([{ kind: "user", source: "caller", userId: "user_caller_1" }]);
	});

	it("uses a visiting human's own token even without a tedi owner", () => {
		expect(
			buildCredentialResolutionTargets({
				descopeTenantId: "org_descope_1",
				callerUserId: "user_caller_1",
				scope: "user",
				actingUserOwnsOrganization: false,
			}),
		).toEqual([{ kind: "user", source: "caller", userId: "user_caller_1" }]);
	});

	it("treats explicit hybrid user-first as the personal-credential opt-in", () => {
		expect(
			buildCredentialResolutionTargets({
				...baseArgs,
				scope: "hybrid",
				preference: "user-first",
				actingUserOwnsOrganization: false,
			}),
		).toEqual([
			{ kind: "user", source: "caller", userId: "user_caller_1" },
			{ kind: "user", source: "owner", userId: "user_owner_1" },
			{ kind: "tenant", tenantId: "org_descope_1" },
		]);
	});

	it("uses the caller once when the caller is also the tedi owner", () => {
		expect(
			buildCredentialResolutionTargets({
				descopeTenantId: "org_descope_1",
				callerUserId: "user_same",
				ownerUserId: "user_same",
				scope: "user",
				actingUserOwnsOrganization: false,
			}),
		).toEqual([{ kind: "user", source: "caller", userId: "user_same" }]);
	});

	it("uses a tedi owner only when no authenticated human is present", () => {
		expect(
			buildCredentialResolutionTargets({
				descopeTenantId: "org_descope_1",
				ownerUserId: "user_owner_1",
				scope: "user",
			}),
		).toEqual([{ kind: "user", source: "owner", userId: "user_owner_1" }]);
	});

	it("does not fall back to tenant scope when user scope has no user targets", () => {
		expect(
			buildCredentialResolutionTargets({
				descopeTenantId: "org_descope_1",
				scope: "user",
			}),
		).toEqual([]);

		expect(buildCredentialResolutionTargets(baseArgs)).toEqual([
			{ kind: "tenant", tenantId: "org_descope_1" },
		]);
	});

	it("does not duplicate the owner lookup when caller and owner match", () => {
		expect(
			buildCredentialResolutionTargets({
				descopeTenantId: "org_descope_1",
				callerUserId: "user_same",
				ownerUserId: "user_same",
				scope: "user",
				actingUserOwnsOrganization: true,
			}),
		).toEqual([{ kind: "user", source: "caller", userId: "user_same" }]);
	});
});

describe("label-scoped credential resolution", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("buildLabeledProviderCandidates", () => {
		it("returns no candidates without a label", () => {
			expect(buildLabeledProviderCandidates("promptwatch-api-key")).toEqual([]);
		});

		it("derives the project-specific outbound app id from suffixed provider ids", () => {
			expect(
				buildLabeledProviderCandidates("promptwatch-api-key", "tedix"),
			).toEqual(["promptwatch-tedix", "promptwatch-api-key-tedix"]);
		});

		it("appends the label for unsuffixed provider ids", () => {
			expect(buildLabeledProviderCandidates("peec", "tedix")).toEqual([
				"peec-tedix",
			]);
		});

		it("returns no candidates when the provider id already targets the label", () => {
			expect(
				buildLabeledProviderCandidates("promptwatch-tedix", "tedix"),
			).toEqual([]);
		});

		it("rejects malformed labels instead of probing arbitrary app ids", () => {
			expect(
				buildLabeledProviderCandidates("promptwatch-api-key", "bad label/../x"),
			).toEqual([]);
			expect(
				buildLabeledProviderCandidates("promptwatch-api-key", "   "),
			).toEqual([]);
		});
	});

	describe("resolveTokenPreferringLabel", () => {
		const tokens: Record<string, { accessToken: string }> = {
			"promptwatch-api-key": { accessToken: "default-key" },
			"promptwatch-tedix": { accessToken: "tedix-key" },
		};

		it("prefers the label-scoped credential when the label matches", async () => {
			const fetchTokenForProvider = vi.fn(async (providerId: string) =>
				providerId in tokens ? tokens[providerId]! : null,
			);
			const result = await resolveTokenPreferringLabel({
				providerId: "promptwatch-api-key",
				label: "tedix",
				fetchTokenForProvider,
			});
			expect(result).toEqual({ accessToken: "tedix-key" });
			// Resolved on the first labeled candidate — never touched the default.
			expect(fetchTokenForProvider).toHaveBeenCalledTimes(1);
			expect(fetchTokenForProvider).toHaveBeenCalledWith("promptwatch-tedix");
		});

		it("falls back to the default credential with a warn when the label has no match", async () => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			const fetchTokenForProvider = vi.fn(async (providerId: string) =>
				providerId === "tavily-api-key" ? { accessToken: "org-key" } : null,
			);
			const result = await resolveTokenPreferringLabel({
				providerId: "tavily-api-key",
				label: "tedix",
				fetchTokenForProvider,
			});
			expect(result).toEqual({ accessToken: "org-key" });
			expect(fetchTokenForProvider).toHaveBeenLastCalledWith("tavily-api-key");
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0]?.[0]).toContain("No labeled credential");
			expect(warn.mock.calls[0]?.[0]).toContain("tavily-api-key");
		});

		it("resolves the default credential directly when no label is provided", async () => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			const fetchTokenForProvider = vi.fn(async (providerId: string) =>
				providerId in tokens ? tokens[providerId]! : null,
			);
			const result = await resolveTokenPreferringLabel({
				providerId: "promptwatch-api-key",
				fetchTokenForProvider,
			});
			expect(result).toEqual({ accessToken: "default-key" });
			expect(fetchTokenForProvider).toHaveBeenCalledTimes(1);
			expect(fetchTokenForProvider).toHaveBeenCalledWith("promptwatch-api-key");
			expect(warn).not.toHaveBeenCalled();
		});

		it("returns null (NOT_FOUND upstream) when neither labeled nor default resolves", async () => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			const fetchTokenForProvider = vi.fn(async () => null);
			const result = await resolveTokenPreferringLabel({
				providerId: "promptwatch-api-key",
				label: "tedix",
				fetchTokenForProvider,
			});
			expect(result).toBeNull();
			expect(warn).toHaveBeenCalledTimes(1);
		});
	});
});

describe("MCP provider provisioning metadata", () => {
	it("prefers saved provider logos and falls back to renderable registry icons", () => {
		expect(
			resolveProviderLogoUrl({
				descopeLogo: "google",
				templateIcon: "https://example.com/google-calendar.png",
			}),
		).toBe("https://example.com/google-calendar.png");

		expect(
			resolveProviderLogoUrl({
				descopeLogo: "data:image/svg+xml;base64,PHN2Zy8+",
				templateIcon: "https://example.com/fallback.png",
			}),
		).toBe("data:image/svg+xml;base64,PHN2Zy8+");

		expect(
			resolveProviderLogoUrl({
				descopeLogo: "data:image/png;base64,Zm9v",
				templateIcon: "github",
			}),
		).toBe("data:image/png;base64,Zm9v");

		expect(
			resolveProviderLogoUrl({
				descopeLogo:
					"https://res-1.cdn.office.net/files/fabric/assets/brand-icons/product/svg/outlook_48x1.svg",
				templateIcon:
					"https://res.cdn.office.net/assets/mail/file-icon/png/outlook_64x64.png",
			}),
		).toBe(
			"https://res-1.cdn.office.net/files/fabric/assets/brand-icons/product/svg/outlook_48x1.svg",
		);

		for (const descopeLogo of [undefined, null, "", "microsoft"]) {
			expect(
				resolveProviderLogoUrl({
					descopeLogo,
					templateIcon: "https://example.com/fallback.png",
				}),
			).toBe("https://example.com/fallback.png");
		}
		expect(resolveProviderLogoUrl({})).toBeNull();
		expect(
			resolveProviderLogoUrl({
				descopeLogo: "microsoft",
				templateIcon: "mail",
			}),
		).toBeNull();
	});

	it("composes compound API-key credentials for tedi and org upload paths", async () => {
		await expect(
			composeApiKeyCredential({
				db: makeTestDb(),
				providerId: "compound-api-key",
				credentialFields: {
					projectId: "P123",
					managementKey: "K456",
				},
				env: { DESCOPE_PROJECT_ID: "Pdefault" } as never,
			}),
		).resolves.toBe("P123:K456");
	});

	it("composes generated provider credentials from org app metadata", async () => {
		const base = {
			id: "facturama-base",
			slug: "facturama",
			metadata: {
				mcpConfig: {
					openApiSync: {
						connectionProviderId: "facturama-api-key",
						credentialProfile: {
							inputFields: [
								{ name: "username", label: "API username", type: "text" },
								{
									name: "password",
									label: "API password",
									type: "password",
								},
							],
							tokenTemplate: "{username}:{password}",
						},
					},
				},
			},
		};
		let selectCount = 0;
		const db = {
			select: () => {
				selectCount += 1;
				const node = {
					from: () => node,
					where: () => Promise.resolve(selectCount === 2 ? [base] : []),
					orderBy: () => Promise.resolve([]),
				};
				return node;
			},
		} as unknown as DbClient;

		await expect(
			composeApiKeyCredential({
				db,
				organizationId: "org-1",
				providerId: "facturama-api-key",
				credentialFields: {
					username: " Acme ",
					password: " secret ",
				},
				env: {} as never,
			}),
		).resolves.toBe("Acme:secret");
	});

	it("refuses credentials for a provider with no D1 row and no Descope outbound app", async () => {
		// Descope keeps serving a deleted outbound app's tenant API-key token and
		// offers no way to delete it, so the retirement check lives here.
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("", { status: 404 }));
		try {
			await expect(
				resolveCredentialChain(
					{
						db: makeTestDb(),
						env: {
							DESCOPE_PROJECT_ID: "P1",
							DESCOPE_MANAGEMENT_KEY: "K1",
						},
					} as never,
					{
						organizationId: "org-1",
						descopeTenantId: "org_tedix",
						providerId: "descope-api-key",
					},
				),
			).rejects.toThrow(/retired/i);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("still serves unregistered providers whose Descope outbound app is live", async () => {
		// Referenced providers without a connection_providers row can still be
		// live — they must not be severed.
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ app: { id: "descope" } }), {
				status: 200,
			}),
		);
		try {
			await expect(
				resolveCredentialChain(
					{
						db: makeTestDb(),
						env: {
							DESCOPE_PROJECT_ID: "P1",
							DESCOPE_MANAGEMENT_KEY: "K1",
						},
					} as never,
					{
						organizationId: "org-1",
						descopeTenantId: "org_tedix",
						providerId: "descope",
					},
				),
			).rejects.not.toThrow(/retired/i);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("does not silently default a missing template field from the environment", async () => {
		// A `projectId` field used to be back-filled from env.DESCOPE_PROJECT_ID
		// for every provider, which would hand a non-Descope integration Descope's
		// project id. An unsupplied required field is now a caller error, not a silent default.
		await expect(
			composeApiKeyCredential({
				db: makeTestDb(),
				providerId: "compound-api-key",
				credentialFields: {
					managementKey: "K456",
				},
				env: { DESCOPE_PROJECT_ID: "Pdefault" } as never,
			}),
		).rejects.toThrow(/Project ID/);
	});

	it("rejects missing required credential fields before Token Vault upload", async () => {
		await expect(
			composeApiKeyCredential({
				db: makeTestDb(),
				providerId: "compound-api-key",
				credentialFields: {},
				env: { DESCOPE_PROJECT_ID: "Pdefault" } as never,
			}),
		).rejects.toThrow(/Missing required credential field "Project ID"/);
	});

	it("copies a base provider profile onto project-specific outbound app ids", async () => {
		const providerTemplate = await resolveConnectionProviderTemplate({
			// getConnectionProviderById does a DB-level WHERE match, which this
			// dumb mock doesn't simulate — pass only the row the query should
			// logically match, mirroring packages/db's own drizzle-double tests.
			db: makeTestDb(
				PROVIDER_FIXTURES.filter((p) => p.id === "promptwatch-api-key"),
			),
			providerId: "promptwatch-tedix",
			baseProviderId: "promptwatch-api-key",
		});

		const provisioning = buildProviderProvisioning({
			providerId: "promptwatch-tedix",
			baseProviderId: "promptwatch-api-key",
			connectionType: "api_key",
			connectionScope: "tenant",
			providerTemplate,
			credentialProfile: providerTemplate?.credentialProfile,
		});

		expect(providerTemplate?.id).toBe("promptwatch-api-key");
		expect(provisioning).toMatchObject({
			connectionProviderId: "promptwatch-tedix",
			baseProviderId: "promptwatch-api-key",
			connectionType: "api_key",
			connectionScope: "tenant",
			recommendedScope: "tenant",
			mcpConfig: {
				connectionProviderId: "promptwatch-tedix",
				connectionScope: "tenant",
			},
		});
		expect(provisioning.credentialProfile?.tokenTemplate).toBe("{apiKey}");
	});

	it("includes OAuth scope requirements in generated mcpConfig metadata", async () => {
		const providerTemplate = await resolveConnectionProviderTemplate({
			db: makeTestDb(PROVIDER_FIXTURES.filter((p) => p.id === "google-gmail")),
			providerId: "google-gmail",
		});

		const provisioning = buildProviderProvisioning({
			providerId: "google-gmail",
			connectionType: "oauth",
			connectionScope: "user",
			connectionScopes: ["https://www.googleapis.com/auth/gmail.compose"],
			providerTemplate,
			credentialProfile: providerTemplate?.credentialProfile,
		});

		expect(provisioning).toMatchObject({
			connectionProviderId: "google-gmail",
			connectionType: "oauth",
			connectionScope: "user",
			connectionScopes: ["https://www.googleapis.com/auth/gmail.compose"],
			mcpConfig: {
				connectionProviderId: "google-gmail",
				connectionScope: "user",
				connectionScopes: ["https://www.googleapis.com/auth/gmail.compose"],
			},
		});
	});

	it("compacts long catalog descriptions before provider creation", () => {
		const longDescription = `
			Peec AI tracks how brands appear across AI engines.

			## Critical rules

			Never narrate tool calls, ID resolution, or intermediate steps.
			${"More detailed MCP instructions. ".repeat(80)}
		`;

		const description = normalizeProviderDescription(longDescription);

		expect(description).toBeDefined();
		expect(description?.length).toBeLessThanOrEqual(254);
		expect(description).toContain("Peec AI tracks");
		expect(description).not.toContain("\n");
		expect(description?.endsWith("...")).toBe(true);
	});

	it("recognizes Descope DCR failures that should use the upstream registration fallback", () => {
		expect(
			isDescopeDcrRegistrationError(
				new Error(
					'Descope outbound app create failed (400 Bad Request): {"errorCode":"E152006","errorMessage":"OAuth metadata with url fetch failed"}',
				),
			),
		).toBe(true);
		expect(isDescopeDcrRegistrationError(new Error("network"))).toBe(false);
	});

	it("registers an upstream MCP OAuth client for Descope without exposing the secret in validation errors", async () => {
		expect(DESCOPE_OUTBOUND_CALLBACK_DOMAIN).toBe("auth.tedix.dev");
		const fetchFn = async (_url: string, init?: RequestInit) => {
			const payload = JSON.parse(String(init?.body ?? "{}"));
			expect(payload).toMatchObject({
				client_name: "Tedix Peec AIH",
				redirect_uris: ["https://auth.tedix.dev/v1/outbound/oauth/callback"],
				grant_types: ["authorization_code", "refresh_token"],
				response_types: ["code"],
				token_endpoint_auth_method: "client_secret_post",
			});
			return new Response(
				JSON.stringify({
					client_id: "client_123",
					client_secret: "secret_456",
					client_secret_expires_at: 1770000000,
				}),
				{ status: 201 },
			);
		};

		await expect(
			registerMcpOAuthClientForDescope({
				dcrUrl: "https://api.peec.ai/mcp/register",
				name: "Peec",
				tokenEndpointAuthMethodsSupported: ["client_secret_post", "none"],
				fetchFn: fetchFn as never,
			}),
		).resolves.toEqual({
			clientId: "client_123",
			clientSecret: "secret_456",
			tokenEndpointAuthMethod: "client_secret_post",
			expiresAt: 1770000000,
		});
	});

	it("recognizes existing static OAuth outbound apps as reconciled providers", () => {
		expect(
			hasStaticOAuthOutboundAppShape({
				id: "peec",
				useDcr: false,
				clientId: "client_123",
				authorizationUrl: "https://api.peec.ai/mcp/authorize",
				tokenUrl: "https://api.peec.ai/mcp/token",
			}),
		).toBe(true);
		expect(
			hasStaticOAuthOutboundAppShape({
				id: "peec",
				useDcr: false,
				authorizationUrl: "https://api.peec.ai/mcp/authorize",
				tokenUrl: "https://api.peec.ai/mcp/token",
			}),
		).toBe(false);
		expect(
			hasStaticOAuthOutboundAppShape({
				id: "peec",
				useDcr: true,
				dcrUrl: "https://api.peec.ai/mcp/register",
			}),
		).toBe(false);
	});

	it("preserves existing static OAuth clients unless DCR migration is requested", () => {
		expect(
			CreateProviderFromMcpInputSchema.parse({
				mcpEndpointUrl: "https://mcp.alpic.ai/mcp",
			}).staticOAuthClientPolicy,
		).toBe("preserve");

		expect(
			CreateProviderFromMcpInputSchema.parse({
				mcpEndpointUrl: "https://mcp.alpic.ai/mcp",
				staticOAuthClientPolicy: "migrate_to_dcr",
			}).staticOAuthClientPolicy,
		).toBe("migrate_to_dcr");

		expect(
			CreateProviderFromMcpInputSchema.parse({
				mcpEndpointUrl: "https://mcp.alpic.ai/mcp",
				staticOAuthClientPolicy: "re_register_static",
			}).staticOAuthClientPolicy,
		).toBe("re_register_static");
	});

	it("preserves the upstream issuer spelling in audit discovery", async () => {
		const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes("oauth-protected-resource")) {
				return Response.json({
					resource: "https://mcp.cloudflare.com/mcp",
					authorization_servers: ["https://mcp.cloudflare.com"],
				});
			}
			return Response.json({
				issuer: "https://mcp.cloudflare.com",
				authorization_endpoint: "https://mcp.cloudflare.com/authorize",
				token_endpoint: "https://mcp.cloudflare.com/token",
			});
		});

		const discovery = await discoverOutboundAppMetadataForAudit(
			"https://mcp.cloudflare.com/mcp",
			fetchFn as typeof fetch,
		);

		expect(discovery.authorizationServer).toBe("https://mcp.cloudflare.com");
	});

	it("rejects token scopes unsupported by the provider template", async () => {
		const providerTemplate = await resolveConnectionProviderTemplate({
			db: makeTestDb(PROVIDER_FIXTURES.filter((p) => p.id === "cloudflare")),
			providerId: "cloudflare",
		});

		expect(() =>
			buildProviderProvisioning({
				providerId: "cloudflare",
				connectionType: "oauth",
				connectionScope: "user",
				providerTemplate,
				credentialProfile: providerTemplate?.credentialProfile,
			}),
		).toThrow(/does not support user-scoped credentials/);
	});

	it("flags static OAuth clients when upstream MCP metadata advertises DCR", () => {
		const audit = auditOutboundAppRecord({
			referencedByOrg: true,
			app: {
				id: "alpic",
				name: "Alpic",
				appType: "oauth",
				useDcr: false,
				clientId: "client_123",
				authorizationUrl: "https://mcp.alpic.ai/oauth2/authorize",
				authorizationUrlParams: [
					{ key: "resource", value: "https://mcp.alpic.ai" },
				],
				tokenUrl: "https://mcp.alpic.ai/oauth2/token",
				tokenUrlParams: [{ key: "resource", value: "https://mcp.alpic.ai" }],
				pkce: true,
				defaultScopes: ["openid"],
				logo: "data:image/png;base64,abc",
			},
			discovery: {
				protectedResourceMetadataUrl:
					"https://mcp.alpic.ai/.well-known/oauth-protected-resource",
				authorizationServerMetadataUrl:
					"https://mcp.alpic.ai/.well-known/oauth-authorization-server",
				resource: "https://mcp.alpic.ai/",
				authorizationServer: "https://mcp.alpic.ai/",
				authorizationUrl: "https://mcp.alpic.ai/oauth2/authorize",
				tokenUrl: "https://mcp.alpic.ai/oauth2/token",
				revocationUrl: null,
				dcrUrl: "https://mcp.alpic.ai/oauth2/register",
				scopesSupported: [],
				authorizationServerScopesSupported: ["openid"],
				codeChallengeMethodsSupported: ["S256"],
				tokenEndpointAuthMethodsSupported: ["client_secret_post"],
				error: null,
			},
		});

		expect(audit.issues.map((issue) => issue.code)).toContain(
			"dcr_capable_static_client",
		);
		expect(audit.issues.map((issue) => issue.code)).not.toContain(
			"resource_parameter_drift",
		);
		expect(audit.settings.registrationMode).toBe("pre_registered");
	});

	it("reports the stable Tedix client metadata identity as CIMD", () => {
		const audit = auditOutboundAppRecord({
			referencedByOrg: true,
			app: {
				id: "cimd-provider",
				name: "CIMD Provider",
				appType: "oauth",
				useDcr: false,
				clientId:
					"https://api.tedix.dev/.well-known/oauth-client/tedix-mcp.json",
				authorizationUrl: "https://auth.example.com/authorize",
				tokenUrl: "https://auth.example.com/token",
				pkce: true,
			},
		});

		expect(audit.settings.registrationMode).toBe("cimd");
		expect(audit.issues.map((issue) => issue.code)).not.toContain(
			"dcr_capable_static_client",
		);
	});

	it("flags disabled PKCE when upstream metadata supports S256", () => {
		const audit = auditOutboundAppRecord({
			referencedByOrg: true,
			app: {
				id: "google-drive",
				name: "Google Drive",
				appType: "oauth",
				clientId: "google-client",
				authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
				authorizationUrlParams: [
					{ key: "resource", value: "https://drivemcp.googleapis.com/mcp" },
				],
				tokenUrl: "https://oauth2.googleapis.com/token",
				tokenUrlParams: [
					{ key: "resource", value: "https://drivemcp.googleapis.com/mcp" },
				],
				pkce: false,
				defaultScopes: [
					"openid",
					"https://www.googleapis.com/auth/drive.readonly",
				],
				logo: "https://example.com/logo.png",
			},
			discovery: {
				protectedResourceMetadataUrl:
					"https://drivemcp.googleapis.com/.well-known/oauth-protected-resource/mcp",
				authorizationServerMetadataUrl:
					"https://accounts.google.com/.well-known/oauth-authorization-server",
				resource: "https://drivemcp.googleapis.com/mcp",
				authorizationServer: "https://accounts.google.com/",
				authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
				tokenUrl: "https://oauth2.googleapis.com/token",
				revocationUrl: null,
				dcrUrl: null,
				scopesSupported: ["https://www.googleapis.com/auth/drive.readonly"],
				authorizationServerScopesSupported: [],
				codeChallengeMethodsSupported: ["plain", "S256"],
				tokenEndpointAuthMethodsSupported: ["client_secret_post"],
				error: null,
			},
		});

		expect(audit.issues.map((issue) => issue.code)).toContain("pkce_disabled");
	});
});

describe("issuer-pin drift gate (ADR tedi-client-oauth-cimd phase 1a)", () => {
	const gate = enforceConnectionProviderIssuerPin;

	it("passes through when the provider has no row at all (first discovery)", async () => {
		await expect(
			gate({
				db: makeTestDb([]),
				providerId: "linear",
				discoveredIssuer: "https://auth.linear.app",
			}),
		).resolves.toBeUndefined();
	});

	it("passes through for a legacy row whose pin is NULL (behaves as today)", async () => {
		await expect(
			gate({
				db: makeTestDb([providerRow({ id: "linear" })]),
				providerId: "linear",
				discoveredIssuer: "https://auth.linear.app",
			}),
		).resolves.toBeUndefined();
	});

	it("passes when a rescan rediscovers the pinned issuer (trailing-slash tolerant)", async () => {
		await expect(
			gate({
				db: makeTestDb([
					providerRow({
						id: "linear",
						pinnedIssuer: "https://auth.linear.app/",
					}),
				]),
				providerId: "linear",
				discoveredIssuer: "https://auth.linear.app",
			}),
		).resolves.toBeUndefined();
	});

	it("refuses fail-closed with CONFLICT when the rediscovered issuer drifts", async () => {
		const drifted = gate({
			db: makeTestDb([
				providerRow({
					id: "linear",
					pinnedIssuer: "https://auth.linear.app",
				}),
			]),
			providerId: "linear",
			discoveredIssuer: "https://evil.example.com",
		});
		await expect(drifted).rejects.toMatchObject({ code: "CONFLICT" });
		await expect(drifted).rejects.toThrow(/issuer drift|pinned to issuer/);
	});
});

describe("connection inventory verification", () => {
	it.each(["present", "expired", "missing", "unknown", "restricted"] as const)(
		"keeps referenced personal setup targets visible when credentials are %s",
		(state) => {
			expect(isInventoryProviderVisible(state, true, false)).toBe(true);
			expect(isInventoryProviderVisible(state, false, true)).toBe(true);
			expect(isInventoryProviderVisible(state, false, false)).toBe(
				state === "present" || state === "expired",
			);
		},
	);
	it("normalizes Descope int64 string expiries before output validation", () => {
		expect(
			summarizeCredential(
				{
					ok: true,
					data: { accessToken: "secret", accessTokenExpiry: "1787950000" },
				},
				1787950001000,
			),
		).toEqual({ state: "expired", expiresAt: 1787950000, scopes: [] });
		for (const accessTokenExpiry of [
			"",
			"unknown",
			"Infinity",
			"-1",
			0,
			Infinity,
			NaN,
		]) {
			expect(
				summarizeCredential({
					ok: true,
					data: { accessToken: "secret", accessTokenExpiry },
				}),
			).toEqual({ state: "present", expiresAt: null, scopes: [] });
		}
	});

	it.each([401, 403, 429, 500, 503])(
		"does not call failed credential inspection %s missing",
		(code) => {
			expect(summarizeCredential({ ok: false, code }).state).toBe(
				code === 401 || code === 403 ? "restricted" : "unknown",
			);
		},
	);
	it("distinguishes absence, expiry and presence without exposing tokens", () => {
		expect(summarizeCredential({ ok: false, code: 404 }).state).toBe("missing");
		expect(summarizeCredential({ ok: true }).state).toBe("unknown");
		expect(
			summarizeCredential({ ok: true, data: { accessToken: "" } }).state,
		).toBe("missing");
		const response = {
			ok: true,
			data: {
				accessToken: "never-return",
				accessTokenExpiry: 100,
				scopes: ["read"],
			},
		};
		expect(summarizeCredential(response, 101000)).toEqual({
			state: "expired",
			expiresAt: 100,
			scopes: ["read"],
		});
		expect(summarizeCredential(response, 99000).state).toBe("present");
		expect(JSON.stringify(summarizeCredential(response))).not.toContain(
			"never-return",
		);
	});
});

describe("credential resolution provider failures", () => {
	it("allows an authorized default credential after a restricted labeled lookup", async () => {
		let calls = 0;
		const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			calls++;
			return new Response(
				JSON.stringify(
					calls === 1
						? { errorCode: "E000", errorDescription: "secret" }
						: { token: { accessToken: "opaque", scopes: [] } },
				),
				{
					status: calls === 1 ? 403 : 200,
					headers: { "Content-Type": "application/json" },
				},
			);
		});
		try {
			await expect(
				resolveCredentialChain(
					{
						db: makeTestDb(),
						env: { DESCOPE_PROJECT_ID: "P1", DESCOPE_MANAGEMENT_KEY: "K1" },
					} as never,
					{
						organizationId: "org-1",
						descopeTenantId: "org_tedix",
						providerId: "cloudflare",
						scope: "tenant",
						label: "primary",
					},
				),
			).resolves.toMatchObject({ accessToken: "opaque" });
			expect(calls).toBeGreaterThan(1);
		} finally {
			spy.mockRestore();
		}
	});

	it.each([401, 403, 429, 500])(
		"preserves upstream %s as unavailable rather than missing",
		async (status) => {
			const spy = vi.spyOn(globalThis, "fetch").mockImplementation(
				async () =>
					new Response(
						JSON.stringify({
							errorCode: "E000",
							errorDescription: "secret upstream body",
						}),
						{ status, headers: { "Content-Type": "application/json" } },
					),
			);
			try {
				await expect(
					resolveCredentialChain(
						{
							db: makeTestDb(),
							env: { DESCOPE_PROJECT_ID: "P1", DESCOPE_MANAGEMENT_KEY: "K1" },
						} as never,
						{
							organizationId: "org-1",
							descopeTenantId: "org_tedix",
							providerId: "cloudflare",
							scope: "tenant",
						},
					),
				).rejects.toMatchObject({
					code: "SERVICE_UNAVAILABLE",
					message: expect.stringContaining(`upstream status ${status}`),
				});
			} finally {
				spy.mockRestore();
			}
		},
	);
	it("keeps definitive 404 as not found", async () => {
		const spy = vi.spyOn(globalThis, "fetch").mockImplementation(
			async () =>
				new Response(JSON.stringify({ errorCode: "E000" }), {
					status: 404,
					headers: { "Content-Type": "application/json" },
				}),
		);
		try {
			await expect(
				resolveCredentialChain(
					{
						db: makeTestDb(),
						env: { DESCOPE_PROJECT_ID: "P1", DESCOPE_MANAGEMENT_KEY: "K1" },
					} as never,
					{
						organizationId: "org-1",
						descopeTenantId: "org_tedix",
						providerId: "cloudflare",
						scope: "tenant",
					},
				),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
		} finally {
			spy.mockRestore();
		}
	});
});

describe("default inventory selectors", () => {
	it("preserves BYOS metadata and withholds named slots", () => {
		expect(
			summarizeCredential({
				ok: true,
				data: { accessToken: "opaque", externalIdentifier: "upstream-org" },
			}).state,
		).toBe("present");
		expect(
			summarizeCredential({
				ok: true,
				data: {
					accessToken: "opaque",
					externalIdentifier: "tedix_11111111-1111-4111-8111-111111111111",
				},
			}).state,
		).toBe("missing");
	});
});
