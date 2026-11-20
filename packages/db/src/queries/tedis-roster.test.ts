import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import {
	policyPacks,
	runtimeProfiles,
	workspaceTemplateSets,
} from "../schema/control-plane";
import { tediRoleAssignments } from "../schema/earned-delegation";
import { organizationMembers } from "../schema/organization-members";
import { organizations } from "../schema/organizations";
import { roleTemplates } from "../schema/role-templates";
import { tedis } from "../schema/tedis";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { createTedi, getTediById, listTediRoster, updateTedi } from "./tedis";

describe("listTediRoster", () => {
	it("searches and pages beyond 50 live tedis with tenant and retirement boundaries", async () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec(
			schemaDdl(
				organizations,
				runtimeProfiles,
				policyPacks,
				workspaceTemplateSets,
				roleTemplates,
				tedis,
				tediRoleAssignments,
			),
		);
		const db = createDbClient(createD1Facade(sqlite));
		await db.insert(organizations).values([
			{ id: "org-1", name: "One", slug: "one" },
			{ id: "org-2", name: "Two", slug: "two" },
		]);
		for (let index = 0; index < 55; index += 1) {
			await db.insert(tedis).values({
				id: `tedi-${index}`,
				organizationId: "org-1",
				name: `Worker ${index}`,
				slug: `worker-${String(index).padStart(3, "0")}`,
				displayName: index === 54 ? "Finance 100%" : `Worker ${index}`,
				status: index === 54 ? null : "active",
			});
		}
		await db.insert(tedis).values([
			{
				id: "retired-finance",
				organizationId: "org-1",
				name: "Finance",
				slug: "retired-finance",
				retiredAt: "2026-09-01T00:00:00.000Z",
			},
			{
				id: "other-finance",
				organizationId: "org-2",
				name: "Finance",
				slug: "other-finance",
			},
		]);
		await db.insert(tediRoleAssignments).values({
			id: "finance-role",
			organizationId: "org-1",
			tediId: "tedi-54",
			roleKey: "engineering-lead",
			roleName: "Engineering Lead",
			assignedAt: "2026-09-01T00:00:00.000Z",
			stageChangedAt: "2026-09-01T00:00:00.000Z",
		});

		const page = await listTediRoster(db, {
			organizationId: "org-1",
			limit: 50,
			offset: 50,
		});
		expect(page.total).toBe(55);
		expect(page.data).toHaveLength(5);
		expect(page.data.at(-1)?.id).toBe("tedi-54");

		const byRole = await listTediRoster(db, {
			organizationId: "org-1",
			limit: 50,
			offset: 0,
			search: "engineering lead",
		});
		expect(byRole.data.map((row) => row.id)).toEqual(["tedi-54"]);
		expect(byRole.total).toBe(1);

		const literal = await listTediRoster(db, {
			organizationId: "org-1",
			limit: 50,
			offset: 0,
			search: "%",
			status: "unknown",
		});
		expect(literal.data.map((row) => row.id)).toEqual(["tedi-54"]);
		expect(literal.total).toBe(1);

		const retired = await listTediRoster(db, {
			organizationId: "org-1",
			limit: 50,
			offset: 0,
			includeRetired: true,
		});
		expect(retired.data.map((row) => row.id)).toEqual(["retired-finance"]);
		expect(retired.total).toBe(1);
		sqlite.close();
	});
});

it("stores the member's canonical owner on create, update and migration", async () => {
	const sqlite = new DatabaseSync(":memory:");
	try {
		sqlite.exec(
			schemaDdl(
				organizations,
				organizationMembers,
				runtimeProfiles,
				policyPacks,
				workspaceTemplateSets,
				roleTemplates,
				tedis,
			),
		);
		const db = createDbClient(createD1Facade(sqlite));
		await db.insert(organizations).values([
			{ id: "org-1", name: "One", slug: "one" },
			{ id: "org-2", name: "Two", slug: "two" },
		]);
		await db.insert(organizationMembers).values([
			{
				id: "m-one",
				organizationId: "org-1",
				userId: "user-one",
				descopeUserId: "subject-one",
				email: "one@example.test",
			},
			{
				id: "m-two",
				organizationId: "org-1",
				userId: "user-two",
				descopeUserId: "subject-two",
				email: "two@example.test",
			},
			{
				id: "m-other",
				organizationId: "org-2",
				userId: "other-user",
				descopeUserId: "subject-one",
				email: "other@example.test",
			},
			{
				id: "m-collision",
				organizationId: "org-1",
				userId: "user-three",
				descopeUserId: "user-one",
				email: "three@example.test",
			},
		]);
		const data = {
			id: "owned",
			organizationId: "org-1",
			name: "Owned",
			slug: "owned",
			ownerUserId: "subject-one",
		};
		expect((await createTedi(db, data)).ownerUserId).toBe("user-one");
		expect(
			(await updateTedi(db, data.id, { ownerUserId: "subject-two" }))
				?.ownerUserId,
		).toBe("user-two");
		expect(
			(await updateTedi(db, data.id, { ownerUserId: "user-one" }))?.ownerUserId,
		).toBe("user-one");
		await expect(
			updateTedi(db, data.id, { ownerUserId: "other-user" }),
		).rejects.toThrow("canonical organization member");
		await expect(
			createTedi(db, {
				...data,
				id: "invalid",
				slug: "invalid",
				ownerUserId: "unknown",
			}),
		).rejects.toThrow("canonical organization member");
		await db.insert(tedis).values({ ...data, id: "legacy", slug: "legacy" });
		sqlite.exec(
			readFileSync(
				new URL(
					"../../drizzle/20261120220607_canonical_tedi_owner/migration.sql",
					import.meta.url,
				),
				"utf8",
			),
		);
		expect((await getTediById(db, "legacy"))?.ownerUserId).toBe("user-one");
		expect((await getTediById(db, "owned"))?.ownerUserId).toBe("user-one");
	} finally {
		sqlite.close();
	}
});
