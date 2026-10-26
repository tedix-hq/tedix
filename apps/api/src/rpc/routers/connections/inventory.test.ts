import { call } from "@orpc/server";
import { ConnectionInventoryInputSchema } from "@tedix/api-contract/schemas/connections";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { apiKeyContext, userContext } from "../../test-context";
import { getConnectionsOverview } from "./inventory";

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
