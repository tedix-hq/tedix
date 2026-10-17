import { createRouterClient } from "@orpc/server";
import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
const mocks = vi.hoisted(() => ({
	get: vi.fn(),
	set: vi.fn(),
	member: vi.fn(),
	list: vi.fn(),
	publish: vi.fn(),
}));
vi.mock("@tedix/db/queries/data-residency", () => ({
	getOrganizationResidencyPolicy: mocks.get,
	setOrganizationResidencyPolicy: mocks.set,
	listResidencyProviders: mocks.list,
	publishResidencyProvider: mocks.publish,
}));
vi.mock("@tedix/db/queries/organization-members", async (original) => ({
	...(await original<
		typeof import("@tedix/db/queries/organization-members")
	>()),
	getMemberByUserId: mocks.member,
}));
import {
	getDataResidency,
	setDataResidency,
	listResidencyProviderCatalog,
	publishResidencyProviderVersion,
} from "./organization-residency";
import type { BaseContext } from "../orpc";
function context(overrides: Partial<BaseContext> = {}): BaseContext {
	return {
		authType: "user",
		organizationId: "org_lark",
		db: {} as never,
		env: { ENVIRONMENT: "test" } as CloudflareEnv,
		headers: new Headers(),
		url: new URL("https://api.example/rpc/organizations"),
		userRole: "admin",
		user: {
			aud: "test",
			dct: "org_lark",
			exp: 2,
			iat: 1,
			iss: "https://auth.example",
			sub: "owner_lark",
			roles: ["admin"],
			permissions: ["settings:manage"],
		},
		...overrides,
	} as BaseContext;
}
function client(ctx = context()) {
	return createRouterClient(
		{
			getDataResidency,
			setDataResidency,
			listResidencyProviderCatalog,
			publishResidencyProviderVersion,
		},
		{ context: ctx },
	);
}
beforeEach(() => {
	vi.resetAllMocks();
	mocks.get.mockResolvedValue(null);
	mocks.member.mockResolvedValue({ status: "active", role: "admin" });
	mocks.set.mockResolvedValue({
		mode: "eu",
		revision: 1,
		updatedBy: "owner_lark",
		updatedAt: "2026-10-18T00:00:00.000Z",
	});
});
describe("organization model residency authorization", () => {
	it("returns unrestricted for an absent row without a write", async () => {
		expect(await client().getDataResidency({})).toEqual({
			mode: "unrestricted",
			revision: 0,
			updatedBy: null,
			updatedAt: null,
		});
		expect(mocks.set).not.toHaveBeenCalled();
		expect(mocks.get.mock.calls[0]![1]).toBe("org_lark");
	});
	it("uses the selected organization and fresh active owner/admin membership", async () => {
		await client().setDataResidency({ mode: "eu", expectedRevision: 0 });
		expect(mocks.member.mock.calls[0]!.slice(1)).toEqual([
			"org_lark",
			"owner_lark",
		]);
		expect(mocks.set.mock.calls[0]![1]).toMatchObject({
			organizationId: "org_lark",
			actorId: "owner_lark",
			expectedRevision: 0,
		});
	});
	it.each([
		{ role: "member", status: "active" },
		{ role: "owner", status: "inactive" },
		undefined,
	])("rejects non-admin and inactive memberships: %j", async (member) => {
		mocks.member.mockResolvedValue(member);
		await expect(
			client().setDataResidency({ mode: "eu", expectedRevision: 0 }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.set).not.toHaveBeenCalled();
	});
	it("does not let a tenant admin publish its own EU geography claims", async () => {
		await expect(
			client().listResidencyProviderCatalog({}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.list).not.toHaveBeenCalled();
	});
	it("rejects a caller-selected foreign organization", async () => {
		await expect(
			client().setDataResidency({
				mode: "eu",
				expectedRevision: 0,
				organizationId: "org_elm",
			} as never),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.set).not.toHaveBeenCalled();
	});
	it("reports concurrent policy changes as a conflict", async () => {
		mocks.set.mockRejectedValue(Error("Residency policy revision conflict"));
		await expect(
			client().setDataResidency({ mode: "eu", expectedRevision: 0 }),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});
});
