import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";

const ORG = "00000000-0000-4000-8000-000000000001";
const MEMBER = "00000000-0000-4000-8000-000000000002";
const TENANT = "test-tenant";
const mocks = vi.hoisted(() => ({
	members: vi.fn(),
	org: vi.fn(),
	management: vi.fn(),
	search: vi.fn(),
	load: vi.fn(),
	loadByUserId: vi.fn(),
	setTenantRoles: vi.fn(),
	addTenant: vi.fn(),
	removeTenant: vi.fn(),
	audit: vi.fn(),
}));
vi.mock("@tedix/db/queries/organization-members", async (original) => ({
	...(await original<
		typeof import("@tedix/db/queries/organization-members")
	>()),
	getMembersByOrganization: mocks.members,
}));
vi.mock("@tedix/db/queries/organizations", async (original) => ({
	...(await original<typeof import("@tedix/db/queries/organizations")>()),
	getOrganizationById: mocks.org,
}));
vi.mock("@tedix/auth/client", () => ({
	getManagementClient: mocks.management,
}));
vi.mock("../audit-helpers", async (original) => ({
	...(await original<typeof import("../audit-helpers")>()),
	emitAuditEvent: mocks.audit,
}));
import { membersContractRouter } from "./members";

const member = {
	id: MEMBER,
	organizationId: ORG,
	descopeUserId: "user-one",
	email: "one@example.com",
	role: "member",
	status: "active",
};
const provider = (
	userId = "user-one",
	email = "one@example.com",
	roles = ["member"],
) => ({
	userId,
	email,
	userTenants: [{ tenantId: TENANT, roleNames: roles }],
});
function context(over: Partial<BaseContext> = {}): BaseContext {
	return {
		authType: "user",
		db: {} as BaseContext["db"],
		env: {
			DESCOPE_PROJECT_ID: "test",
			DESCOPE_MANAGEMENT_KEY: "test",
		} as CloudflareEnv,
		headers: new Headers(),
		organizationId: ORG,
		userRole: "owner",
		url: new URL("https://api.tedix.test/rpc/members"),
		user: { sub: "owner", roles: ["owner"], permissions: ["team:manage"] },
		...over,
	} as BaseContext;
}
const client = (over: Partial<BaseContext> = {}) =>
	createRouterClient(membersContractRouter, { context: () => context(over) });
const repair = {
	organizationId: ORG,
	action: "restore_descope" as const,
	targetId: MEMBER,
	reason: "Repair failed invitation sync",
	confirm: true as const,
};

describe("membership reconciliation", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.org.mockResolvedValue({ id: ORG, descopeTenantId: TENANT });
		mocks.members.mockResolvedValue([member]);
		mocks.search.mockResolvedValue({ ok: true, data: { users: [] } });
		mocks.loadByUserId.mockResolvedValue({
			ok: true,
			data: { ...provider(), userTenants: [] },
		});
		mocks.setTenantRoles.mockResolvedValue({ ok: true });
		mocks.addTenant.mockResolvedValue({ ok: true });
		mocks.removeTenant.mockResolvedValue({ ok: true });
		mocks.audit.mockResolvedValue(undefined);
		mocks.management.mockReturnValue({
			management: {
				user: {
					search: mocks.search,
					load: mocks.load,
					loadByUserId: mocks.loadByUserId,
					setTenantRoles: mocks.setTenantRoles,
					addTenant: mocks.addTenant,
					removeTenant: mocks.removeTenant,
				},
			},
		});
	});

	it("surfaces ambiguous invitation identities without offering a destructive repair", async () => {
		mocks.members.mockResolvedValue([
			{ ...member, descopeUserId: "pending:one", status: "invited" },
		]);
		mocks.search.mockResolvedValue({
			ok: true,
			data: { users: [provider(), provider("duplicate")] },
		});
		expect(
			(await client().getMembershipReconciliation({ organizationId: ORG }))
				.divergences,
		).toEqual([
			expect.objectContaining({ kind: "identity_conflict", memberId: MEMBER }),
		]);
		await expect(
			client().repairMembership({
				...repair,
				action: "remove_descope",
				targetId: "duplicate",
			}),
		).rejects.toThrow(/no longer exists/);
		expect(mocks.removeTenant).not.toHaveBeenCalled();
	});

	it("recovers a partial restore where tenant creation succeeded but role synchronization failed", async () => {
		let tenants: Array<{ tenantId: string; roleNames: string[] }> = [];
		mocks.search.mockImplementation(async () => ({
			ok: true,
			data: {
				users: tenants.length ? [{ ...provider(), userTenants: tenants }] : [],
			},
		}));
		mocks.loadByUserId.mockImplementation(async () => ({
			ok: true,
			data: { ...provider(), userTenants: tenants },
		}));
		mocks.addTenant.mockImplementation(async () => {
			tenants = [{ tenantId: TENANT, roleNames: [] }];
			return { ok: true };
		});
		mocks.setTenantRoles
			.mockResolvedValueOnce({ ok: false, error: { errorCode: "TEMPORARY" } })
			.mockImplementation(async () => {
				tenants = provider().userTenants;
				return { ok: true };
			});
		await expect(client().repairMembership(repair)).rejects.toThrow();
		expect(
			(await client().getMembershipReconciliation({ organizationId: ORG }))
				.divergences,
		).toEqual([expect.objectContaining({ kind: "role_mismatch" })]);
		await expect(client().repairMembership(repair)).resolves.toMatchObject({
			verified: true,
		});
		expect(mocks.addTenant).toHaveBeenCalledExactlyOnceWith("user-one", TENANT);
	});

	it("reports both directions and deactivated D1 memberships without writing", async () => {
		mocks.members.mockResolvedValue([
			member,
			{
				...member,
				id: "inactive",
				descopeUserId: "inactive",
				status: "deactivated",
			},
		]);
		mocks.search.mockResolvedValue({
			ok: true,
			data: { users: [provider("extra"), provider("inactive")] },
		});
		const result = await client().getMembershipReconciliation({
			organizationId: ORG,
		});
		expect(result.divergences).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "missing_descope", memberId: MEMBER }),
				expect.objectContaining({ kind: "missing_d1", descopeUserId: "extra" }),
				expect.objectContaining({
					kind: "inactive_d1",
					descopeUserId: "inactive",
				}),
			]),
		);
		expect(mocks.setTenantRoles).not.toHaveBeenCalled();
		expect(mocks.removeTenant).not.toHaveBeenCalled();
		expect(mocks.audit).not.toHaveBeenCalled();
	});

	it("matches invited emails but never substitutes email for a resolved subject", async () => {
		mocks.members.mockResolvedValue([
			{ ...member, status: "invited", descopeUserId: "pending:one" },
		]);
		mocks.search.mockResolvedValue({
			ok: true,
			data: { users: [provider("other", " ONE@example.com ")] },
		});
		expect(
			(await client().getMembershipReconciliation({ organizationId: ORG }))
				.divergences,
		).toEqual([]);
		mocks.members.mockResolvedValue([member]);
		expect(
			(
				await client().getMembershipReconciliation({ organizationId: ORG })
			).divergences.map((item) => item.kind),
		).toEqual(["missing_descope", "missing_d1"]);
	});

	it("does not classify tedi identities or users from another tenant as human drift", async () => {
		mocks.members.mockResolvedValue([]);
		mocks.search.mockResolvedValue({
			ok: true,
			data: {
				users: [
					{ ...provider(), customAttributes: { entityType: "tedi" } },
					{
						...provider("foreign"),
						userTenants: [{ tenantId: "other", roleNames: [] }],
					},
				],
			},
		});
		expect(
			(await client().getMembershipReconciliation({ organizationId: ORG }))
				.divergences,
		).toEqual([]);
	});

	it("reads past the first page in both systems", async () => {
		const rows = Array.from({ length: 100 }, (_, i) => ({
			...member,
			id: `member-${i}`,
			descopeUserId: `user-${i}`,
		}));
		mocks.members.mockResolvedValueOnce(rows).mockResolvedValueOnce([member]);
		mocks.search
			.mockResolvedValueOnce({
				ok: true,
				data: { users: rows.map((row) => provider(row.descopeUserId)) },
			})
			.mockResolvedValueOnce({ ok: true, data: { users: [] } });
		expect(
			(await client().getMembershipReconciliation({ organizationId: ORG }))
				.divergences,
		).toEqual([expect.objectContaining({ memberId: MEMBER })]);
		expect(mocks.search).toHaveBeenLastCalledWith({
			tenantIds: [TENANT],
			limit: 100,
			page: 1,
		});
		expect(mocks.members).toHaveBeenLastCalledWith(expect.anything(), ORG, {
			limit: 100,
			offset: 100,
		});
	});

	it("fails closed on incomplete inventory and provider failure", async () => {
		mocks.search.mockResolvedValue({
			ok: false,
			error: { errorCode: "UNAVAILABLE" },
		});
		await expect(client().repairMembership(repair)).rejects.toThrow();
		mocks.search.mockResolvedValue({ ok: true });
		await expect(client().repairMembership(repair)).rejects.toThrow(
			/inventory unavailable/,
		);
		mocks.search.mockResolvedValue({ ok: true, data: { users: [], total: 1 } });
		await expect(client().repairMembership(repair)).rejects.toThrow(
			/inventory is incomplete/,
		);
		expect(mocks.setTenantRoles).not.toHaveBeenCalled();
	});

	it("rejects unbounded inventories rather than assuming missing members", async () => {
		mocks.members.mockResolvedValue(Array.from({ length: 100 }, () => member));
		await expect(client().repairMembership(repair)).rejects.toThrow(
			/exceeds reconciliation limit/,
		);
		expect(mocks.setTenantRoles).not.toHaveBeenCalled();
	});

	it("restores one association only after intent is audited and verifies provider readback", async () => {
		mocks.loadByUserId
			.mockResolvedValueOnce({
				ok: true,
				data: { ...provider(), userTenants: [] },
			})
			.mockResolvedValueOnce({ ok: true, data: provider() });
		const result = await client().repairMembership(repair);
		expect(result.verified).toBe(true);
		expect(mocks.setTenantRoles).toHaveBeenCalledExactlyOnceWith(
			"user-one",
			TENANT,
			["member"],
		);
		expect(mocks.audit.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.setTenantRoles.mock.invocationCallOrder[0],
		);
		expect(mocks.audit.mock.calls.map((call) => call[1].action)).toEqual([
			"member.reconciliation.requested",
			"member.reconciliation.verified",
		]);
		expect(mocks.audit.mock.calls[1][1]).toMatchObject({
			organizationId: ORG,
			actorId: "owner",
			metadata: {
				repairId: result.repairId,
				reason: repair.reason,
				descopeUserId: "user-one",
			},
		});
	});

	it("repairs a pending invitation using an existing identity without activating D1", async () => {
		mocks.members.mockResolvedValue([
			{ ...member, status: "invited", descopeUserId: "pending:one" },
		]);
		mocks.load.mockResolvedValue({
			ok: true,
			data: { ...provider(), userTenants: [] },
		});
		mocks.loadByUserId.mockResolvedValue({ ok: true, data: provider() });
		await expect(client().repairMembership(repair)).resolves.toMatchObject({
			verified: true,
		});
		expect(mocks.load).toHaveBeenCalledWith(member.email);
	});

	it("removes a Descope-only association and leaves other tenants intact", async () => {
		mocks.members.mockResolvedValue([]);
		mocks.search.mockResolvedValue({ ok: true, data: { users: [provider()] } });
		mocks.loadByUserId
			.mockResolvedValueOnce({ ok: true, data: provider() })
			.mockResolvedValueOnce({
				ok: true,
				data: {
					...provider(),
					userTenants: [{ tenantId: "other", roleNames: ["owner"] }],
				},
			});
		await expect(
			client().repairMembership({
				...repair,
				action: "remove_descope",
				targetId: "user-one",
			}),
		).resolves.toMatchObject({ verified: true });
		expect(mocks.removeTenant).toHaveBeenCalledExactlyOnceWith(
			"user-one",
			TENANT,
		);
	});

	it("prevents external mutation if intent auditing fails", async () => {
		mocks.audit.mockRejectedValue(new Error("audit unavailable"));
		await expect(client().repairMembership(repair)).rejects.toThrow(
			/audit unavailable/,
		);
		expect(mocks.setTenantRoles).not.toHaveBeenCalled();
	});

	it.each(["provider", "readback"])(
		"audits failure for %s errors without reporting success",
		async (stage) => {
			if (stage === "provider")
				mocks.setTenantRoles.mockResolvedValue({
					ok: false,
					error: { errorCode: "FAIL" },
				});
			await expect(client().repairMembership(repair)).rejects.toThrow();
			expect(mocks.audit.mock.calls.map((call) => call[1].action)).toEqual([
				"member.reconciliation.requested",
				"member.reconciliation.failed",
			]);
		},
	);

	it("rejects stale repairs and requires explicit confirmation and reason", async () => {
		mocks.search.mockResolvedValue({ ok: true, data: { users: [provider()] } });
		await expect(client().repairMembership(repair)).rejects.toThrow(
			/no longer exists/,
		);
		await expect(
			client().repairMembership({ ...repair, confirm: false as true }),
		).rejects.toThrow();
		await expect(
			client().repairMembership({ ...repair, reason: " " }),
		).rejects.toThrow();
		expect(mocks.setTenantRoles).not.toHaveBeenCalled();
	});

	it("enforces tenant boundary, admin role, machine scope and target hierarchy", async () => {
		await expect(
			client({ organizationId: "other" }).repairMembership(repair),
		).rejects.toThrow(/access denied/);
		await expect(
			client({ userRole: "member" }).getMembershipReconciliation({
				organizationId: ORG,
			}),
		).rejects.toThrow(/Insufficient permissions|Only admins/);
		await expect(
			client({
				authType: "apikey",
				apiKey: { id: "key", scopes: ["team:read"] } as BaseContext["apiKey"],
			}).repairMembership(repair),
		).rejects.toThrow();
		mocks.members.mockResolvedValue([{ ...member, role: "owner" }]);
		await expect(
			client({ userRole: "admin" }).repairMembership(repair),
		).rejects.toThrow(/outranks/);
		expect(mocks.setTenantRoles).not.toHaveBeenCalled();
	});

	it("refuses to remove provider roles above the caller or outside the known catalog", async () => {
		mocks.members.mockResolvedValue([]);
		for (const role of ["owner", "custom-platform-role"]) {
			mocks.search.mockResolvedValue({
				ok: true,
				data: { users: [provider("user-one", member.email, [role])] },
			});
			await expect(
				client({ userRole: "admin" }).repairMembership({
					...repair,
					action: "remove_descope",
					targetId: "user-one",
				}),
			).rejects.toThrow();
		}
		expect(mocks.removeTenant).not.toHaveBeenCalled();
	});

	it("reports absent tenant configuration and management credentials", async () => {
		await expect(
			client({ env: {} as CloudflareEnv }).getMembershipReconciliation({
				organizationId: ORG,
			}),
		).rejects.toThrow(/management key/);
		mocks.org.mockResolvedValue({ id: ORG });
		await expect(
			client().getMembershipReconciliation({ organizationId: ORG }),
		).rejects.toThrow(/no Descope tenant/);
	});
});
