import { createRouterClient } from "@orpc/server";
import { DatabaseSync } from "node:sqlite";
import { eq } from "drizzle-orm";
import { createDbClient } from "@tedix/db/client";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { organizations } from "@tedix/db/schema/organizations";
import { auditEvents } from "@tedix/db/schema/audit-events";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { membersContractRouter } from "./members";

const org = "00000000-0000-4000-8000-000000000001";
const agent = "00000000-0000-4000-8000-000000000002";
const person = "00000000-0000-4000-8000-000000000003";
const otherOrg = "00000000-0000-4000-8000-000000000004";

async function fixture(role = "owner") {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(schemaDdl(organizations, organizationMembers, auditEvents));
	const db = createDbClient(createD1Facade(sqlite));
	await db.insert(organizations).values([
		{ id: org, name: "Fictional team", slug: "fictional-team" },
		{ id: otherOrg, name: "Other team", slug: "other-team" },
	]);
	await db.insert(organizationMembers).values([
		{
			id: agent,
			organizationId: org,
			descopeUserId: "juniper-provider",
			userId: "juniper",
			email: "juniper@example.test",
			role: "member",
			status: "active",
		},
		{
			id: person,
			organizationId: org,
			descopeUserId: "river-provider",
			userId: "river",
			email: "river@example.test",
			name: "River",
			role: "owner",
			status: "active",
		},
	]);
	const context = {
		db,
		authType: "user",
		organizationId: org,
		userId: "river",
		userRole: role,
		headers: new Headers(),
		env: {},
		url: new URL("https://api.example.test/rpc/members"),
		user: {
			sub: "river-provider",
			roles: [role],
			permissions: ["team:read", "team:manage"],
		},
	} as BaseContext;
	return {
		db,
		sqlite,
		client: createRouterClient(membersContractRouter, { context }),
	};
}

const input = {
	organizationId: org,
	memberId: agent,
	identity: {
		kind: "external_agent" as const,
		displayName: "Juniper",
		representedUserId: "river",
	},
};

describe("browser agent member identity", () => {
	it("retains the inviter and distinguishes requested from a saved invitation without a provider", async () => {
		const { client, sqlite } = await fixture();
		const result = await client.inviteMember({
			organizationId: org,
			email: "cedar@example.test",
			role: "member",
		});
		expect(result.data).toMatchObject({
			invitedBy: "river",
			status: "invited",
			role: "member",
		});
		const events = sqlite
			.prepare("SELECT actor_id, action FROM audit_events ORDER BY rowid")
			.all();
		expect(events).toEqual([
			{ actor_id: "river", action: "member.invite_requested" },
			{ actor_id: "river", action: "member.invitation_created" },
		]);
	});

	it("refuses an invite before side effects when the initiating audit cannot be stored", async () => {
		const { client, sqlite } = await fixture();
		sqlite.exec(
			"CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
		);
		await expect(
			client.inviteMember({
				organizationId: org,
				email: "cedar@example.test",
				role: "member",
			}),
		).rejects.toThrow();
		expect(
			sqlite
				.prepare("SELECT count(*) AS count FROM organization_members")
				.get(),
		).toMatchObject({ count: 2 });
	});

	it("persists identity, resolves an off-page person, and audits the actual actor without changing role", async () => {
		const { client, sqlite } = await fixture();
		const result = await client.setMemberIdentity(input);
		expect(result.data).toMatchObject({
			name: "Juniper",
			kind: "external_agent",
			representedUserId: "river",
			role: "member",
			customPermissions: null,
		});
		const list = await client.listMembers({
			organizationId: org,
			limit: 1,
			offset: 0,
		});
		const agents = list.data.filter((member) => member.id === agent);
		expect(agents).toHaveLength(1);
		expect(agents[0]?.representedUserName).toBe("River");
		const event = sqlite
			.prepare(
				"SELECT actor_id, action, resource_id FROM audit_events WHERE action = 'member.identity_set'",
			)
			.get();
		expect(event).toMatchObject({
			actor_id: "river",
			action: "member.identity_set",
			resource_id: agent,
		});
		await client.setMemberIdentity({ ...input, identity: { kind: "human" } });
		expect(
			(await client.getMember({ organizationId: org, memberId: agent })).data,
		).toMatchObject({ kind: "human", representedUserId: null, role: "member" });
	});

	it("rejects a member's attempt to declare representation", async () => {
		const { client, sqlite } = await fixture("member");
		await expect(client.setMemberIdentity(input)).rejects.toThrow();
		expect(
			sqlite
				.prepare("SELECT kind FROM organization_members WHERE id = ?")
				.get(agent),
		).toMatchObject({ kind: "human" });
	});

	it("leaves identity unchanged if its audit intent cannot be persisted", async () => {
		const { client, sqlite } = await fixture();
		sqlite.exec(
			"CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
		);
		await expect(client.setMemberIdentity(input)).rejects.toThrow();
		expect(
			sqlite
				.prepare("SELECT kind, role FROM organization_members WHERE id = ?")
				.get(agent),
		).toMatchObject({ kind: "human", role: "member" });
	});

	it("rejects self, missing, inactive, cross-org and agent representation", async () => {
		const { client, db } = await fixture();
		for (const representedUserId of ["juniper", "absent"]) {
			await expect(
				client.setMemberIdentity({
					...input,
					identity: { ...input.identity, representedUserId },
				}),
			).rejects.toThrow();
		}
		await db
			.update(organizationMembers)
			.set({ status: "deactivated" })
			.where(eq(organizationMembers.id, person));
		await expect(client.setMemberIdentity(input)).rejects.toThrow();
		await db
			.update(organizationMembers)
			.set({ status: "active", organizationId: otherOrg })
			.where(eq(organizationMembers.id, person));
		await expect(client.setMemberIdentity(input)).rejects.toThrow();
		await db
			.update(organizationMembers)
			.set({ organizationId: org, kind: "external_agent" })
			.where(eq(organizationMembers.id, person));
		await expect(client.setMemberIdentity(input)).rejects.toThrow();
		await expect(
			client.setMemberIdentity({ ...input, organizationId: otherOrg }),
		).rejects.toThrow();
	});
});
