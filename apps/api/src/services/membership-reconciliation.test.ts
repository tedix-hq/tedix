import { DatabaseSync } from "node:sqlite";
import { createDbClient } from "@tedix/db/client";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";
import {
	descopeTenantRolesForMemberRole,
	readMembershipReconciliation,
} from "./membership-reconciliation";

const ORG = "org-example";
const TENANT = "tenant-example";
type Management = Parameters<typeof readMembershipReconciliation>[1];

function provider(
	userId: string,
	roles = ["member"],
	email = `${userId}@example.com`,
) {
	return {
		userId,
		email,
		userTenants: [{ tenantId: TENANT, roleNames: roles }],
	};
}

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	onTestFinished(() => sqlite.close());
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(schemaDdl(organizationMembers));
	const db = createDbClient(createD1Facade(sqlite));
	const insert = sqlite.prepare(
		"INSERT INTO organization_members (id, organization_id, descope_user_id, email, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
	);
	function member(
		userId: string,
		role = "member",
		email = `${userId}@example.com`,
		status = "active",
		organizationId = ORG,
	) {
		insert.run(
			`${organizationId}:${userId}`,
			organizationId,
			userId,
			email,
			role,
			status,
			userId,
		);
	}
	const search = vi.fn().mockResolvedValue({ ok: true, data: { users: [] } });
	const management = {
		management: { user: { search } },
	} as unknown as Management;
	return {
		member,
		search,
		read: () => readMembershipReconciliation(db, management, ORG, TENANT),
	};
}

describe("membership reconciliation service", () => {
	it.each([
		["owner", ["owner", "admin"]],
		["admin", ["admin"]],
		["member", ["member"]],
		["viewer", ["viewer"]],
	] as const)(
		"maps %s to provider roles and accepts a matching inventory",
		async (role, roles) => {
			const f = fixture();
			f.member("user-one", role);
			f.search.mockResolvedValue({
				ok: true,
				data: { users: [provider("user-one", [...roles].reverse())] },
			});
			expect(descopeTenantRolesForMemberRole(role)).toEqual(roles);
			expect((await f.read()).report.divergences).toEqual([]);
		},
	);

	it("reports missing members in both directions without crossing organization boundaries", async () => {
		const f = fixture();
		f.member("missing-provider");
		f.member(
			"provider-only",
			"owner",
			"provider-only@example.com",
			"active",
			"org-other",
		);
		f.search.mockResolvedValue({
			ok: true,
			data: { users: [provider("provider-only")] },
		});
		expect((await f.read()).report.divergences).toEqual([
			{
				kind: "missing_descope",
				memberId: `${ORG}:missing-provider`,
				descopeUserId: "missing-provider",
				email: "missing-provider@example.com",
				role: "member",
				descopeRoles: [],
			},
			{
				kind: "missing_d1",
				memberId: null,
				descopeUserId: "provider-only",
				email: "provider-only@example.com",
				role: null,
				descopeRoles: ["member"],
			},
		]);
	});

	it("reports owner role drift when the provider lacks the mapped admin role", async () => {
		const f = fixture();
		f.member("user-one", "owner");
		f.search.mockResolvedValue({
			ok: true,
			data: { users: [provider("user-one", ["owner"])] },
		});
		expect((await f.read()).report.divergences).toEqual([
			{
				kind: "role_mismatch",
				memberId: `${ORG}:user-one`,
				descopeUserId: "user-one",
				email: "user-one@example.com",
				role: "owner",
				descopeRoles: ["owner"],
			},
		]);
	});

	it("matches pending invitations after trimming and folding email case", async () => {
		const f = fixture();
		f.member("pending:one", "member", " ONE@Example.com ", "invited");
		f.search.mockResolvedValue({
			ok: true,
			data: { users: [provider("user-one", ["member"], " one@EXAMPLE.COM ")] },
		});
		expect((await f.read()).report.divergences).toEqual([]);
	});

	it("reads the second page of both inventories before classifying drift", async () => {
		const f = fixture();
		const users = Array.from({ length: 101 }, (_, i) =>
			provider(`user-${String(i).padStart(3, "0")}`),
		);
		for (const user of users) f.member(user.userId);
		f.search
			.mockResolvedValueOnce({
				ok: true,
				data: { users: users.slice(0, 100), total: 101 },
			})
			.mockResolvedValueOnce({
				ok: true,
				data: { users: users.slice(100), total: 101 },
			});
		const result = await f.read();
		expect(result.members).toHaveLength(101);
		expect(result.report.divergences).toEqual([]);
		expect(f.search.mock.calls).toEqual([
			[{ tenantIds: [TENANT], limit: 100, page: 0 }],
			[{ tenantIds: [TENANT], limit: 100, page: 1 }],
		]);
	});

	it("rejects a provider error after a full page instead of returning removable members", async () => {
		const f = fixture();
		f.search
			.mockResolvedValueOnce({
				ok: true,
				data: {
					users: Array.from({ length: 100 }, (_, i) => provider(`extra-${i}`)),
				},
			})
			.mockResolvedValueOnce({
				ok: false,
				error: { errorCode: "UNAVAILABLE" },
			});
		await expect(f.read()).rejects.toThrow(/user.search/);
		expect(f.search).toHaveBeenCalledTimes(2);
	});

	it("rejects a short provider page whose total proves the inventory is incomplete", async () => {
		const f = fixture();
		f.search.mockResolvedValue({
			ok: true,
			data: { users: [provider("extra")], total: 2 },
		});
		await expect(f.read()).rejects.toThrow(/inventory is incomplete/);
	});

	it.each(["D1", "provider"])(
		"rejects the %s page cap instead of returning any partial report",
		async (side) => {
			const f = fixture();
			if (side === "D1") {
				for (let i = 0; i < 10_000; i++) f.member(`user-${i}`);
				f.search.mockResolvedValue({
					ok: true,
					data: { users: [provider("extra")] },
				});
			} else {
				f.search.mockResolvedValue({
					ok: true,
					data: {
						users: Array.from({ length: 100 }, (_, i) =>
							provider(`extra-${i}`),
						),
					},
				});
			}
			await expect(f.read()).rejects.toThrow(
				/inventory exceeds reconciliation limit; no repair is safe/,
			);
			expect(f.search).toHaveBeenCalledTimes(side === "provider" ? 100 : 1);
		},
	);
});
