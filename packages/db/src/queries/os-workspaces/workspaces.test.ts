import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { osWorkspaces } from "../../schema/os-workspaces";
import { userConfigs } from "../../schema/user-configs";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import {
	createOsWorkspace,
	deleteOsWorkspace,
	getOsWorkspace,
	listOsWorkspaces,
	updateOsWorkspace,
} from "./workspaces";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	// The OS table is emitted from the same Drizzle object production uses, so a
	// column added to `os_workspaces` cannot drift away from what this fixture
	// creates. Only the `organizations` parent is stubbed — these queries read
	// none of its columns, they just need the FK target to exist.
	sqlite.exec(`
		PRAGMA foreign_keys = ON;
		CREATE TABLE organizations (id TEXT PRIMARY KEY NOT NULL);
		INSERT INTO organizations (id) VALUES ('org-1'), ('org-2');
	`);
	sqlite.exec(schemaDdl(osWorkspaces, userConfigs));
	return createDbQueryClient(createD1Facade(sqlite));
}

const workspace = {
	id: "ws-1",
	organizationId: "org-1",
	name: "Operations",
	createdByKind: "user" as const,
	createdById: "u-1",
};

describe("os workspaces", () => {
	it("creates and reads only inside the owning organization", async () => {
		const db = fixture();
		const created = await createOsWorkspace(db, workspace);
		expect(created).toMatchObject({ id: "ws-1", status: "active" });
		expect(
			await getOsWorkspace(db, {
				organizationId: "org-1",
				workspaceId: "ws-1",
			}),
		).toMatchObject({ name: "Operations" });
		expect(
			await getOsWorkspace(db, {
				organizationId: "org-2",
				workspaceId: "ws-1",
			}),
		).toBeUndefined();
		expect(await listOsWorkspaces(db, "org-1")).toHaveLength(1);
		expect(await listOsWorkspaces(db, "org-2")).toHaveLength(0);
	});

	it("enforces the per-organization name uniqueness, not global", async () => {
		const db = fixture();
		await createOsWorkspace(db, workspace);
		await expect(
			createOsWorkspace(db, { ...workspace, id: "ws-dup" }),
		).rejects.toThrow();
		expect(
			await createOsWorkspace(db, {
				...workspace,
				id: "ws-2",
				organizationId: "org-2",
			}),
		).toMatchObject({ id: "ws-2" });
	});

	it("updates and archives within tenant scope only", async () => {
		const db = fixture();
		await createOsWorkspace(db, workspace);
		expect(
			await updateOsWorkspace(
				db,
				{ organizationId: "org-2", workspaceId: "ws-1" },
				{ status: "archived" },
			),
		).toBeUndefined();
		const archived = await updateOsWorkspace(
			db,
			{ organizationId: "org-1", workspaceId: "ws-1" },
			{ status: "archived", description: "retired" },
		);
		expect(archived).toMatchObject({
			status: "archived",
			description: "retired",
		});
		const filtered = await listOsWorkspaces(db, "org-1", { status: "active" });
		expect(filtered).toHaveLength(0);
	});

	it("deletes within tenant scope and reports whether a row went", async () => {
		const db = fixture();
		await createOsWorkspace(db, workspace);
		expect(
			await deleteOsWorkspace(db, {
				organizationId: "org-2",
				workspaceId: "ws-1",
			}),
		).toBe(false);
		expect(
			await deleteOsWorkspace(db, {
				organizationId: "org-1",
				workspaceId: "ws-1",
			}),
		).toBe(true);
		expect(await listOsWorkspaces(db, "org-1")).toHaveLength(0);
	});

	it("deletes every user's presentation preference in the same D1 batch", async () => {
		const db = fixture();
		await createOsWorkspace(db, workspace);
		await db.insert(userConfigs).values([
			{
				id: "pref-1",
				userId: "u-1",
				namespace: "tedix-os-workspaces:org-1",
				key: "ws-1",
				value: { favorite: true },
			},
			{
				id: "pref-2",
				userId: "u-2",
				namespace: "tedix-os-workspaces:org-1",
				key: "ws-1",
				value: { favorite: false },
			},
		]);
		expect(
			await deleteOsWorkspace(db, {
				organizationId: "org-1",
				workspaceId: "ws-1",
				preferenceNamespace: "tedix-os-workspaces:org-1",
			}),
		).toBe(true);
		expect(await db.select().from(userConfigs)).toHaveLength(0);
	});
});
