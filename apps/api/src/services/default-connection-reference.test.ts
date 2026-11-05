import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../rpc/orpc";
import {
	defaultTenantCredentialReference,
	readDefaultRepositoryCredential,
} from "./default-connection-reference";

const mocks = vi.hoisted(() => ({
	provider: vi.fn(),
	org: vi.fn(),
	resources: vi.fn(),
	token: vi.fn(),
	grants: vi.fn(),
	request: vi.fn(),
}));
vi.mock("@tedix/db/queries/connection-providers", () => ({
	getConnectionProviderByDescopeAppId: mocks.provider,
}));
vi.mock("@tedix/db/queries/organizations", () => ({
	getOrganizationById: mocks.org,
	getConnectionConsumerGrants: mocks.grants,
}));
vi.mock("@tedix/db/queries/connection-instances", () => ({
	getOrganizationConnectionAllowedResources: mocks.resources,
}));
vi.mock("@tedix/db/queries/connection-access-requests", () => ({
	getConnectionAccessOwner: vi.fn(async () => null),
	createConnectionAccessRequest: mocks.request,
}));
vi.mock("../lib/descope-management", () => ({
	getDescopeManagement: () => ({}),
}));
vi.mock("@tedix/auth/connections", async (original) => ({
	...(await original<typeof import("@tedix/auth/connections")>()),
	fetchTenantConnectionToken: mocks.token,
}));

const input = {
	masterKey: "fictional-master",
	organizationId: "org-example",
	tenantId: "tenant-example",
	providerId: "github-pat-key",
	token: { id: "vault-id-private", accessToken: "fictional-opaque-pat" },
};
const context = {
	db: {},
	organizationId: input.organizationId,
	env: { SECRETS_MASTER_KEY: input.masterKey },
	authType: "tedi",
	tediId: "tedi-example",
	headers: new Headers(),
} as BaseContext;
const repositories = ["Example/Product", "example/operations"];
beforeEach(() => {
	vi.clearAllMocks();
	mocks.provider.mockResolvedValue({
		id: "github-pat-key",
		descopeAppId: "github-pat-key",
		type: "api_key",
		category: "development",
	});
	mocks.org.mockResolvedValue({
		descopeTenantId: input.tenantId,
		metadata: {},
	});
	mocks.resources.mockResolvedValue(null);
	mocks.token.mockResolvedValue(input.token);
	mocks.grants.mockResolvedValue({ mode: "all" });
});
const reference = async () => (await defaultTenantCredentialReference(input))!;

describe("opaque default credential revision", () => {
	it("is stable and exposes only a safe selector", async () => {
		const ref = await reference();
		expect(ref).toEqual(await reference());
		expect(ref).toEqual({
			organizationId: input.organizationId,
			providerId: input.providerId,
			scope: "tenant",
			accountRevisionDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
		expect(JSON.stringify(ref)).not.toContain(input.token.accessToken);
		expect(JSON.stringify(ref)).not.toContain(input.token.id);
	});
	it.each([
		"organizationId",
		"tenantId",
		"providerId",
		"masterKey",
		"id",
		"accessToken",
	])("changes with %s including in-place rotation", async (field) => {
		const changed =
			field === "id" || field === "accessToken"
				? { ...input, token: { ...input.token, [field]: "different" } }
				: { ...input, [field]: "different" };
		expect(
			(await defaultTenantCredentialReference(changed))?.accountRevisionDigest,
		).not.toBe((await reference()).accountRevisionDigest);
	});
	it.each([
		{ masterKey: undefined },
		{ tenantId: "" },
		{ token: { ...input.token, id: "" } },
		{ token: { ...input.token, accessToken: "" } },
		{ token: { ...input.token, reconnectNeeded: true } },
		{ token: { ...input.token, expiresAt: 1 } },
		{
			token: {
				...input.token,
				externalIdentifier: "tedix_00000000-0000-4000-8000-000000000001",
			},
		},
	])("omits unavailable/unverified references", async (change) => {
		expect(
			await defaultTenantCredentialReference({ ...input, ...change }),
		).toBeNull();
	});
});

describe("native registered repository credential", () => {
	it("checks both normalized resources and permits the actual policy consumer", async () => {
		mocks.resources.mockResolvedValue(
			repositories.map((resourceId) => ({
				resourceType: "github_repository",
				resourceId: resourceId.toLowerCase(),
			})),
		);
		mocks.grants.mockResolvedValue({
			mode: "selected",
			tediIds: ["tedi-example"],
			skills: [],
		});
		expect(
			await readDefaultRepositoryCredential(
				context,
				input.organizationId,
				await reference(),
				repositories,
			),
		).toBe(input.token.accessToken);
		expect(mocks.grants).toHaveBeenCalledWith(
			context.db,
			input.organizationId,
			input.providerId,
			undefined,
		);
	});
	it.each([
		{ resources: [] },
		{
			resources: [
				{ resourceType: "github_repository", resourceId: "example/product" },
			],
		},
		{
			resources: [
				{
					resourceType: "notion_page",
					resourceId: "00000000-0000-4000-8000-000000000001",
				},
			],
		},
	])(
		"denies excluded ops repository before vault access",
		async ({ resources }) => {
			mocks.resources.mockResolvedValue(resources);
			await expect(
				readDefaultRepositoryCredential(
					context,
					input.organizationId,
					await reference(),
					repositories,
				),
			).rejects.toThrow("allowed resources");
			expect(mocks.token).not.toHaveBeenCalled();
		},
	);
	it.each([undefined, "other-tedi"])(
		"does not impersonate the owner or trust unverified skill headers",
		async (tediId) => {
			mocks.grants.mockResolvedValue({
				mode: "selected",
				tediIds: ["tedi-example"],
				skills: [],
			});
			await expect(
				readDefaultRepositoryCredential(
					{
						...context,
						tediId,
						headers: new Headers({ "X-Tedix-Skill-Run-Id": "forged" }),
					},
					input.organizationId,
					await reference(),
					repositories,
				),
			).rejects.toThrow();
			expect(mocks.token).not.toHaveBeenCalled();
		},
	);
	it("refuses own-access requirements without claiming a personal proof", async () => {
		mocks.provider.mockResolvedValue({
			id: "github-pat-key",
			type: "api_key",
			category: "storage",
		});
		await expect(
			readDefaultRepositoryCredential(
				context,
				input.organizationId,
				await reference(),
				repositories,
			),
		).rejects.toThrow("personal resource access");
		expect(mocks.token).not.toHaveBeenCalled();
	});
	it.each([
		null,
		{ ...input.token, id: "replacement" },
		{ ...input.token, accessToken: "rotated-in-place" },
		{ ...input.token, reconnectNeeded: true },
	])("refuses disconnected or changed live vault identity", async (token) => {
		mocks.token.mockResolvedValue(token);
		await expect(
			readDefaultRepositoryCredential(
				context,
				input.organizationId,
				await reference(),
				repositories,
			),
		).rejects.toThrow("revision changed");
	});
	it("propagates unavailable lookup without returning stale credentials", async () => {
		mocks.token.mockRejectedValue(new Error("lookup unavailable"));
		await expect(
			readDefaultRepositoryCredential(
				context,
				input.organizationId,
				await reference(),
				repositories,
			),
		).rejects.toThrow("lookup unavailable");
	});
	it("refuses cross-tenant and non-GitHub registered selections before vault access", async () => {
		await expect(
			readDefaultRepositoryCredential(
				context,
				"other-org",
				await reference(),
				repositories,
			),
		).rejects.toThrow("organization mismatch");
		mocks.provider.mockResolvedValue({
			id: "other-service",
			type: "api_key",
			category: "development",
		});
		await expect(
			readDefaultRepositoryCredential(
				context,
				input.organizationId,
				await reference(),
				repositories,
			),
		).rejects.toThrow("GitHub");
		expect(mocks.token).not.toHaveBeenCalled();
	});
});
