import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const MEMBER_ID = "00000000-0000-4000-8000-000000000002";
const DESCOPE_USER_ID = "descope-user";

const mocks = vi.hoisted(() => ({
	getMemberById: vi.fn(),
	getOrganizationById: vi.fn(),
	updateMemberRole: vi.fn(),
	getManagementClient: vi.fn(),
	setTenantRoles: vi.fn(),
}));

vi.mock("@tedix/db/queries/organization-members", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/organization-members")
	>()),
	getMemberById: mocks.getMemberById,
	updateMemberRole: mocks.updateMemberRole,
}));

vi.mock("@tedix/db/queries/organizations", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/db/queries/organizations")>()),
	getOrganizationById: mocks.getOrganizationById,
}));

vi.mock("@tedix/auth/client", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/auth/client")>()),
	getManagementClient: mocks.getManagementClient,
}));

import { membersContractRouter } from "./members";

const member = {
	id: MEMBER_ID,
	organizationId: ORG_ID,
	descopeUserId: DESCOPE_USER_ID,
	email: "member@example.com",
	name: null,
	avatarUrl: null,
	role: "member",
	customPermissions: null,
	status: "active",
	invitedAt: null,
	invitedBy: null,
	inviteAcceptedAt: null,
	lastActiveAt: null,
	createdAt: null,
	updatedAt: null,
};

function context(managementKey = "test-key"): BaseContext {
	return {
		authType: "user",
		db: {} as BaseContext["db"],
		env: {
			DESCOPE_PROJECT_ID: "test-project",
			DESCOPE_MANAGEMENT_KEY: managementKey,
		} as CloudflareEnv,
		headers: new Headers(),
		organizationId: ORG_ID,
		userRole: "owner",
		url: new URL("https://api.tedix.test/rpc/members"),
		user: {
			sub: "owner-user",
			roles: ["owner"],
			permissions: ["team:manage"],
		},
	} as BaseContext;
}

const input = {
	organizationId: ORG_ID,
	memberId: MEMBER_ID,
	role: "admin" as const,
};

describe("members.updateMemberRole Descope synchronization", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getOrganizationById.mockResolvedValue({
			id: ORG_ID,
			descopeTenantId: "org_test",
		});
		mocks.getMemberById.mockResolvedValue(member);
		mocks.updateMemberRole.mockResolvedValue({ ...member, role: "admin" });
		mocks.getManagementClient.mockReturnValue({
			management: { user: { setTenantRoles: mocks.setTenantRoles } },
		});
		mocks.setTenantRoles.mockResolvedValue({ ok: true });
	});

	it("returns success only after Descope confirms the role", async () => {
		const result = await createRouterClient(membersContractRouter, {
			context,
		}).updateMemberRole(input);
		expect(result.data.role).toBe("admin");
		expect(mocks.setTenantRoles).toHaveBeenCalledWith(
			DESCOPE_USER_ID,
			"org_test",
			["admin"],
		);
	});

	it("reports a partial update when Descope returns ok=false", async () => {
		mocks.setTenantRoles.mockResolvedValue({
			ok: false,
			error: { errorCode: "E_TEST" },
		});
		await expect(
			createRouterClient(membersContractRouter, { context }).updateMemberRole(
				input,
			),
		).rejects.toThrow(/changed in Tedix but Descope synchronization failed/);
		expect(mocks.updateMemberRole).toHaveBeenCalledOnce();
	});

	it("reports a partial update when Descope throws", async () => {
		mocks.setTenantRoles.mockRejectedValue(new Error("provider unavailable"));
		await expect(
			createRouterClient(membersContractRouter, { context }).updateMemberRole(
				input,
			),
		).rejects.toThrow(/changed in Tedix but Descope synchronization failed/);
		expect(mocks.updateMemberRole).toHaveBeenCalledOnce();
	});

	it("does not change D1 when Descope management is unavailable", async () => {
		await expect(
			createRouterClient(membersContractRouter, {
				context: () => context(""),
			}).updateMemberRole(input),
		).rejects.toThrow(/member role was not changed/);
		expect(mocks.updateMemberRole).not.toHaveBeenCalled();
	});
});
