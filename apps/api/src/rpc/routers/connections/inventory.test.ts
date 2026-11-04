import { call } from "@orpc/server";
import { ConnectionInventoryInputSchema } from "@tedix/api-contract/schemas/connections";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { apiKeyContext, userContext } from "../../test-context";
import {
	foldDefaultAccounts,
	getConnectionsOverview,
	readGoogleAccountEmail,
} from "./inventory";

const mocks = vi.hoisted(() => ({
	fetchToken: vi.fn(),
	instances: vi.fn(),
}));

vi.mock("../../../lib/descope-management", () => ({
	getDescopeManagement: () => ({
		management: {
			outboundApplication: {
				fetchToken: mocks.fetchToken,
				fetchTenantToken: mocks.fetchToken,
			},
		},
	}),
}));
vi.mock("@tedix/db/queries/organizations", () => ({
	getOrganizationById: vi.fn(async () => ({ descopeTenantId: "tenant-1" })),
}));
vi.mock("@tedix/db/queries/connection-providers", async (original) => ({
	...(await original<
		typeof import("@tedix/db/queries/connection-providers")
	>()),
	listConnectionProviders: vi.fn(async () => []),
}));
vi.mock("@tedix/db/queries/connection-instances", () => ({
	listConnectionInstances: mocks.instances,
}));
vi.mock("./discovery-user", () => ({
	readConnectionProviders: vi.fn(async () => ({
		data: ["present", "missing", "expired", "restricted", "unknown"].map(
			(state) => ({
				appId: state,
				name: state,
				description: null,
				enabled: true,
				availableScopes: [],
				logoUrl: null,
				connectionType: "oauth",
				registrationMode: "pre_registered",
				tokenScope: "tenant",
				supportedScopes: ["tenant", "user"],
				recommendedScope: "tenant",
				accountMode: "multiple",
				availableAccountModes: ["single", "multiple"],
			}),
		),
	})),
}));
vi.mock("./provider-registration", () => ({
	collectReferencedProviders: vi.fn(async () => ({
		references: new Map(
			["present", "missing", "expired", "restricted", "unknown"].map(
				(state) => [
					state,
					[{ appId: "app-1", appSlug: "example", source: "app" }],
				],
			),
		),
		complete: true,
		toolCapabilities: new Map(),
		toolCapabilitiesComplete: new Map(),
	})),
}));

beforeEach(() => {
	vi.clearAllMocks();
	mocks.instances.mockResolvedValue([]);
	mocks.fetchToken.mockImplementation(async (providerId: string) => {
		switch (providerId) {
			case "present":
				return { ok: true, data: { accessToken: "test-token" } };
			case "expired":
				return {
					ok: true,
					data: { accessToken: "test-token", reconnectNeeded: true },
				};
			case "missing":
				return { ok: false, code: 404 };
			case "restricted":
				return { ok: false, code: 403 };
			default:
				throw new Error("Provider unavailable");
		}
	});
});

describe.each(["organization", "personal"] as const)(
	"%s inventory filters",
	(scope) => {
		const context = () =>
			scope === "personal"
				? userContext({ permissions: ["apps:read"] })
				: apiKeyContext({ scopes: ["apps:read"] });
		const overview = (input: Record<string, unknown>) =>
			call(
				getConnectionsOverview,
				ConnectionInventoryInputSchema.parse({ scope, ...input }),
				{ context: context() },
			);

		it.each([
			["all", ["expired", "missing", "present", "restricted", "unknown"]],
			["attention", ["expired", "missing"]],
			["unchecked", ["restricted", "unknown"]],
			["in_use", ["expired", "missing", "present", "restricted", "unknown"]],
			["unused", []],
		])(
			"filters %s without hiding verification failures",
			async (status, expected) => {
				const result = await overview({ status });
				expect(result.rows.map((row) => row.accountState)).toEqual(expected);
				expect(result.total).toBe(expected.length);
				expect(result.hasMore).toBe(false);
				expect(result.verificationComplete).toBe(false);
				expect(result.issues).toContainEqual(
					expect.objectContaining({ source: "credentials" }),
				);
			},
		);

		it("applies unchecked before pagination and combines it with search", async () => {
			const page = await overview({ status: "unchecked", limit: 1 });
			expect(page.rows.map((row) => row.accountState)).toEqual(["restricted"]);
			expect(page.total).toBe(2);
			expect(page.hasMore).toBe(true);
			const next = await overview({ status: "unchecked", limit: 1, offset: 1 });
			expect(next.rows.map((row) => row.accountState)).toEqual(["unknown"]);
			expect(next.hasMore).toBe(false);
			const search = await overview({ status: "unchecked", q: "RESTRICTED" });
			expect(search.rows.map((row) => row.accountState)).toEqual([
				"restricted",
			]);
			expect(search.total).toBe(1);
		});
	},
);

describe("one row per account", () => {
	const provider = { appId: "google-gmail", name: "Google Gmail" };
	const ref = (appId: string) => ({
		appId,
		appSlug: appId,
		source: "app" as const,
	});
	const row = (extra: Record<string, unknown>) =>
		({
			provider,
			scope: "user",
			accountState: "present",
			accountLabel: null,
			connection: null,
			references: [],
			referencesComplete: true,
			access: "not_evaluated",
			health: "not_checked",
			...extra,
		}) as unknown as Parameters<typeof foldDefaultAccounts>[0][number];

	it("folds the default login into the named slot that adopted it", () => {
		const rows = foldDefaultAccounts(
			[
				row({
					isDefault: true,
					accountEmail: "owner@example.com",
					references: [ref("gmail"), ref("gmail-tedix")],
				}),
				row({
					connectionInstanceId: "slot-default",
					instanceLabel: "Gmail (default)",
					isDefault: false,
				}),
				row({
					connectionInstanceId: "slot-second",
					instanceLabel: "Account",
					isDefault: false,
					references: [ref("gmail-tedix")],
				}),
			],
			{
				instances: [
					{ id: "slot-default", providerId: "google-gmail", tokenIds: ["t1"] },
					{ id: "slot-second", providerId: "google-gmail", tokenIds: ["t2"] },
				],
				defaultTokenIds: new Map([["google-gmail", "t1"]]),
				pins: new Map([
					[
						"gmail-tedix",
						{ providerId: "google-gmail", connectionInstanceId: "slot-second" },
					],
				]),
			},
		);
		expect(
			rows.map((account) => ({
				id: account.connectionInstanceId,
				isDefault: account.isDefault,
				email: account.accountEmail,
				apps: account.references.map((reference) => reference.appId),
			})),
		).toEqual([
			{
				id: "slot-default",
				isDefault: true,
				email: "owner@example.com",
				apps: ["gmail"],
			},
			{
				id: "slot-second",
				isDefault: false,
				email: undefined,
				apps: ["gmail-tedix"],
			},
		]);
	});

	it("keeps an unadopted default row but drops apps pinned elsewhere", () => {
		const rows = foldDefaultAccounts(
			[
				row({
					isDefault: true,
					references: [ref("gmail"), ref("gmail-tedix")],
				}),
				row({
					connectionInstanceId: "slot-second",
					references: [ref("gmail-tedix")],
				}),
			],
			{
				instances: [
					{ id: "slot-second", providerId: "google-gmail", tokenIds: ["t2"] },
				],
				defaultTokenIds: new Map([["google-gmail", "t1"]]),
				pins: new Map([
					[
						"gmail-tedix",
						{ providerId: "google-gmail", connectionInstanceId: "slot-second" },
					],
				]),
			},
		);
		expect(
			rows.map((account) => account.references.map((r) => r.appId)),
		).toEqual([["gmail"], ["gmail-tedix"]]);
	});
});

describe("readGoogleAccountEmail", () => {
	const gmail = "https://www.googleapis.com/auth/gmail.readonly";
	it("reads the Gmail address with a Google token", async () => {
		const fetcher = vi.fn(async () =>
			Response.json({ emailAddress: "sam@example.com" }),
		);
		await expect(
			readGoogleAccountEmail("token", [gmail], fetcher as typeof fetch),
		).resolves.toBe("sam@example.com");
		expect(fetcher).toHaveBeenCalledWith(
			"https://gmail.googleapis.com/gmail/v1/users/me/profile?fields=emailAddress",
			expect.objectContaining({
				headers: { Authorization: "Bearer token" },
			}),
		);
	});

	it("falls back to the userinfo address when Gmail refuses", async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(new Response(null, { status: 403 }))
			.mockResolvedValueOnce(Response.json({ email: "owner@example.com" }));
		await expect(
			readGoogleAccountEmail(
				"token",
				[gmail, "https://www.googleapis.com/auth/userinfo.email"],
				fetcher as typeof fetch,
			),
		).resolves.toBe("owner@example.com");
	});

	it("never sends a non-Google token to Google", async () => {
		const fetcher = vi.fn();
		await expect(
			readGoogleAccountEmail("token", ["email", "Mail.Read"], fetcher),
		).resolves.toBeNull();
		expect(fetcher).not.toHaveBeenCalled();
	});
});
