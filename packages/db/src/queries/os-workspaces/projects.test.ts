import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { osWorkspaceProjects, osWorkspaces } from "../../schema/os-workspaces";
import { projects } from "../../schema/projects";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import {
	createOsWorkspaceProject,
	getOsWorkspaceProject,
	listOsWorkspaceProjects,
	reactivateOsWorkspaceProject,
	removeOsWorkspaceProject,
} from "./projects";

async function seed() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		"CREATE TABLE organizations (id TEXT PRIMARY KEY NOT NULL); CREATE TABLE tedis (id TEXT PRIMARY KEY NOT NULL); CREATE TABLE tedi_objectives (id TEXT PRIMARY KEY NOT NULL); INSERT INTO organizations VALUES ('org-1'), ('org-2');",
	);
	sqlite.exec(schemaDdl(projects, osWorkspaces, osWorkspaceProjects));
	const db = createDbQueryClient(createD1Facade(sqlite));
	await db.insert(projects).values({
		id: "project-1",
		orgId: "org-1",
		key: "FIN",
		name: "Finance",
		createdAt: "2026-09-21T00:00:00.000Z",
	});
	await db.insert(osWorkspaces).values({
		id: "workspace-1",
		organizationId: "org-1",
		name: "Books",
		createdByKind: "user",
		createdById: "user-1",
	});
	const link = await createOsWorkspaceProject(db, {
		id: "link-1",
		organizationId: "org-1",
		workspaceId: "workspace-1",
		projectId: "project-1",
		createdByKind: "user",
		createdById: "user-1",
		createdAt: "2026-09-21T00:00:00.000Z",
		updatedAt: "2026-09-21T00:00:00.000Z",
	});
	return { db, link };
}

describe("OS Workspace Work projects", () => {
	it("scopes links by organization and Workspace", async () => {
		const { db } = await seed();
		expect(
			await listOsWorkspaceProjects(db, {
				organizationId: "org-1",
				workspaceId: "workspace-1",
				status: "active",
			}),
		).toHaveLength(1);
		expect(
			await getOsWorkspaceProject(db, {
				organizationId: "org-2",
				workspaceId: "workspace-1",
				projectId: "project-1",
			}),
		).toBeUndefined();
	});

	it("soft-removes with CAS and reactivates the canonical link", async () => {
		const { db, link } = await seed();
		expect(
			await removeOsWorkspaceProject(db, {
				organizationId: "org-1",
				workspaceId: "workspace-1",
				projectId: "project-1",
				expectedUpdatedAt: "stale",
				now: "2026-09-21T01:00:00.000Z",
			}),
		).toBeUndefined();
		const removed = await removeOsWorkspaceProject(db, {
			organizationId: "org-1",
			workspaceId: "workspace-1",
			projectId: "project-1",
			expectedUpdatedAt: link.updatedAt,
			now: "2026-09-21T01:00:00.000Z",
		});
		expect(removed?.status).toBe("removed");
		const restored = await reactivateOsWorkspaceProject(db, {
			organizationId: "org-1",
			workspaceId: "workspace-1",
			projectId: "project-1",
			now: "2026-09-21T02:00:00.000Z",
		});
		expect(restored).toMatchObject({ status: "active", removedAt: null });
	});
});
