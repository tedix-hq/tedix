import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "./context";

const mocks = vi.hoisted(() => ({ member: vi.fn(), canonical: vi.fn() }));
vi.mock("@tedix/db/queries/organization-members", () => ({
	getMemberByUserId: mocks.member,
	getMemberByCanonicalUserId: mocks.canonical,
}));
import { getRequestOrganizationMembership } from "./org-membership";

const context = () =>
	({
		db: {},
		organizationMembership: {
			organizationId: "org-1",
			subject: "user-1",
			descopeUserId: "user-1",
			id: "member-1",
			userId: "canonical-1",
			kind: "human",
			customPermissions: null,
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
		).resolves.toEqual({
			id: "member-1",
			organizationId: "org-1",
			userId: "canonical-1",
			descopeUserId: "user-1",
			kind: "human",
			status: "active",
			role: "member",
			customPermissions: null,
		});
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

describe("request member identity reuse", () => {
	function completeContext() {
		const ctx = context();
		ctx.organizationMembership = {
			...ctx.organizationMembership!,
			id: "member-1",
			userId: "canonical-1",
			kind: "human",
			customPermissions: ["apps:read"],
		};
		return ctx;
	}
	it("carries the persisted identity without either membership lookup", async () => {
		const ctx = completeContext();
		await expect(
			getRequestOrganizationMembership(ctx, "org-1", "user-1", {
				canonicalUserId: "canonical-1",
			}),
		).resolves.toEqual({
			id: "member-1",
			organizationId: "org-1",
			userId: "canonical-1",
			descopeUserId: "user-1",
			kind: "human",
			status: "active",
			role: "member",
			customPermissions: ["apps:read"],
		});
		expect(mocks.canonical).not.toHaveBeenCalled();
		expect(mocks.member).not.toHaveBeenCalled();
	});
	it("keeps canonical-first fallback when a snapshot is incomplete", async () => {
		const ctx = context();
		delete ctx.organizationMembership!.id;
		mocks.canonical.mockResolvedValueOnce(undefined);
		mocks.member.mockResolvedValueOnce({ id: "legacy", userId: "canonical-1" });
		await expect(
			getRequestOrganizationMembership(ctx, "org-1", "user-1", {
				canonicalUserId: "canonical-1",
			}),
		).resolves.toEqual({ id: "legacy", userId: "canonical-1" });
		expect(mocks.canonical).toHaveBeenCalledWith(
			ctx.db,
			"org-1",
			"canonical-1",
		);
		expect(mocks.member).toHaveBeenCalledWith(ctx.db, "org-1", "user-1");
	});
	it("does not replace a different canonical identity with a cached legacy member", async () => {
		const ctx = completeContext();
		mocks.canonical.mockResolvedValueOnce({
			id: "other-member",
			userId: "canonical-2",
		});
		await expect(
			getRequestOrganizationMembership(ctx, "org-1", "user-1", {
				canonicalUserId: "canonical-2",
			}),
		).resolves.toEqual({ id: "other-member", userId: "canonical-2" });
		expect(mocks.member).not.toHaveBeenCalled();
	});
	it("keeps provider-subject lookups distinct from mapped canonical subjects", async () => {
		const ctx = completeContext();
		ctx.organizationMembership!.descopeUserId = "legacy-subject";
		mocks.member.mockResolvedValue(undefined);
		await expect(
			getRequestOrganizationMembership(ctx, "org-1", "user-1"),
		).resolves.toBeUndefined();
		expect(mocks.member).toHaveBeenCalledOnce();
		await expect(
			getRequestOrganizationMembership(ctx, "org-1", "user-1", {
				canonicalUserId: "canonical-1",
			}),
		).resolves.toMatchObject({ userId: "canonical-1" });
		expect(mocks.canonical).not.toHaveBeenCalled();
	});
});

it("does not add a subject fallback to canonical-only callers", async () => {
	const ctx = context();
	ctx.organizationMembership = undefined;
	mocks.canonical.mockResolvedValueOnce(undefined);
	await expect(
		getRequestOrganizationMembership(ctx, "org-1", "user-1", {
			canonicalUserId: "canonical-1",
			fallbackToSubject: false,
		}),
	).resolves.toBeUndefined();
	expect(mocks.member).not.toHaveBeenCalled();
});
