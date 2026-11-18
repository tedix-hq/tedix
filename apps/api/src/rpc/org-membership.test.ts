import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "./context";

const mocks = vi.hoisted(() => ({ member: vi.fn() }));
vi.mock("@tedix/db/queries/organization-members", () => ({
	getMemberByUserId: mocks.member,
}));
import { getRequestOrganizationMembership } from "./org-membership";

const context = () =>
	({
		db: {},
		organizationMembership: {
			organizationId: "org-1",
			subject: "user-1",
			status: "active",
			role: "member",
		},
	}) as BaseContext;

beforeEach(() => vi.clearAllMocks());

describe("request membership reuse", () => {
	it("avoids another read for the authenticated membership", async () => {
		const ctx = context();
		await expect(
			getRequestOrganizationMembership(ctx, "org-1", "user-1"),
		).resolves.toBe(ctx.organizationMembership);
		expect(mocks.member).not.toHaveBeenCalled();
	});

	it.each([
		["org-2", "user-1"],
		["org-1", "user-2"],
	])(
		"reads a distinct org or person: %s %s",
		async (organizationId, subject) => {
			const ctx = context();
			mocks.member.mockResolvedValueOnce(undefined);
			await expect(
				getRequestOrganizationMembership(ctx, organizationId, subject),
			).resolves.toBeUndefined();
			expect(mocks.member).toHaveBeenCalledWith(
				ctx.db,
				organizationId,
				subject,
			);
		},
	);

	it("does not substitute token roles for a missing membership", async () => {
		const ctx = context();
		ctx.organizationMembership = undefined;
		ctx.userRole = "owner";
		mocks.member.mockResolvedValueOnce({
			role: "member",
			status: "deactivated",
		});
		await expect(
			getRequestOrganizationMembership(ctx, "org-1", "user-1"),
		).resolves.toEqual({ role: "member", status: "deactivated" });
		expect(mocks.member).toHaveBeenCalledOnce();
	});
});
