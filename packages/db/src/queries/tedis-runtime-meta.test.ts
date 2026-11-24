import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vite-plus/test";
import { createDbClient, type DbClient } from "../client";
import {
	policyPacks,
	runtimeProfiles,
	workspaceTemplateSets,
} from "../schema/control-plane";
import { organizationMembers } from "../schema/organization-members";
import { organizations } from "../schema/organizations";
import { tedis } from "../schema/tedis";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { listCallableTedisBySlugs, listTediRuntimeMetaBySlugs } from "./tedis";

/**
 * Minimal drizzle double: `select().from().where()` resolves to `rows`.
 * `select` is a spy so we can assert the empty-slug guard short-circuits before
 * touching the database.
 */
function makeDb(rows: unknown[]): {
	db: DbClient;
	select: ReturnType<typeof vi.fn>;
} {
	const node = {
		from: () => node,
		where: () => Promise.resolve(rows),
	};
	const select = vi.fn(() => node);
	return { db: { select } as unknown as DbClient, select };
}

describe("listTediRuntimeMetaBySlugs", () => {
	it("short-circuits on an empty slug list without querying", async () => {
		const { db, select } = makeDb([{ slug: "x" }]);
		const out = await listTediRuntimeMetaBySlugs(db, []);
		expect(out).toEqual([]);
		expect(select).not.toHaveBeenCalled();
	});

	it("dedups slugs before querying (guard survives all-duplicate input)", async () => {
		const { db, select } = makeDb([]);
		// All-duplicate, non-empty input must still query (unique set is non-empty).
		await listTediRuntimeMetaBySlugs(db, ["a", "a", "a"]);
		expect(select).toHaveBeenCalledTimes(1);
	});

	it("returns the served projection rows unchanged", async () => {
		const rows = [
			{
				slug: "cto",
				id: "id-cto",
				organizationId: "org-1",
				runtimeKind: "agent",
				runtimeState: "active",
				status: "active",
			},
		];
		const { db } = makeDb(rows);
		const out = await listTediRuntimeMetaBySlugs(db, ["cto"]);
		expect(out).toEqual(rows);
	});
});

describe("listCallableTedisBySlugs", () => {
	it("returns organization tedis to the organization and a personal tedi only to its owner", async () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec(
			schemaDdl(
				organizations,
				organizationMembers,
				runtimeProfiles,
				policyPacks,
				workspaceTemplateSets,
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
				id: "m-owner",
				organizationId: "org-1",
				userId: "user-owner",
				descopeUserId: "subject-owner",
				email: "owner@example.test",
			},
			{
				id: "m-other",
				organizationId: "org-1",
				userId: "user-other",
				descopeUserId: "subject-other",
				email: "other@example.test",
			},
			{
				id: "m-left",
				organizationId: "org-1",
				userId: "user-left",
				descopeUserId: "subject-left",
				email: "left@example.test",
				status: "deactivated",
			},
			// The same person in another organization owns nothing in org-1.
			{
				id: "m-elsewhere",
				organizationId: "org-2",
				userId: "user-elsewhere",
				descopeUserId: "subject-elsewhere",
				email: "elsewhere@example.test",
			},
		]);
		const tedi = (
			slug: string,
			values: Partial<typeof tedis.$inferInsert> = {},
		) => ({
			id: `id-${slug}`,
			organizationId: "org-1",
			name: slug,
			slug,
			scope: "organization" as const,
			status: "active" as const,
			runtimeState: "active" as const,
			...values,
		});
		// One row per insert: D1 binds at most 100 values per statement.
		for (const row of [
			tedi("shared"),
			tedi("mine", { scope: "personal", ownerUserId: "user-owner" }),
			tedi("theirs", { scope: "personal", ownerUserId: "user-other" }),
			tedi("left", { scope: "personal", ownerUserId: "user-left" }),
			tedi("ownerless", { scope: "personal" }),
			tedi("archived", { runtimeState: "archived" }),
			tedi("paused", { status: "paused" }),
			tedi("provisioning", { status: "provisioning" }),
			tedi("broken", { status: "error" }),
			tedi("retired", { retiredAt: "2026-11-01T00:00:00.000Z" }),
			tedi("mine-archived", {
				scope: "personal",
				ownerUserId: "user-owner",
				runtimeState: "archived",
			}),
			tedi("foreign", { organizationId: "org-2" }),
			tedi("foreign-mine", {
				organizationId: "org-2",
				scope: "personal",
				ownerUserId: "user-owner",
			}),
		])
			await db.insert(tedis).values(row);
		const slugs = [
			"shared",
			"mine",
			"theirs",
			"left",
			"ownerless",
			"archived",
			"paused",
			"provisioning",
			"broken",
			"retired",
			"mine-archived",
			"foreign",
			"foreign-mine",
		];
		const callable = async (callerUserId?: string, organizationId = "org-1") =>
			(
				await listCallableTedisBySlugs(db, {
					organizationId,
					slugs,
					callerUserId,
				})
			)
				.map((row) => row.slug)
				.sort();

		// The owner, by canonical user id or by sign-in subject.
		expect(await callable("user-owner")).toEqual(["mine", "shared"]);
		expect(await callable("subject-owner")).toEqual(["mine", "shared"]);
		// Another member, a deactivated owner, a stranger and a caller that is
		// not a person get organization tedis only.
		expect(await callable("user-other")).toEqual(["shared", "theirs"]);
		expect(await callable("user-left")).toEqual(["shared"]);
		expect(await callable("user-elsewhere")).toEqual(["shared"]);
		expect(await callable()).toEqual(["shared"]);
		// Another organization never sees org-1's tedis, nor the owner's there.
		expect(await callable("user-elsewhere", "org-2")).toEqual(["foreign"]);
		expect(
			await listCallableTedisBySlugs(db, {
				organizationId: "org-1",
				slugs: ["mine"],
				callerUserId: "user-owner",
			}),
		).toEqual([
			{
				slug: "mine",
				id: "id-mine",
				organizationId: "org-1",
				scope: "personal",
				runtimeKind: "agent",
			},
		]);
	});
});
